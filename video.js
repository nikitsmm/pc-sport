/* ============================================================
   video.js — запись видео прямо в браузере, маленького размера.

   Идея: не звать системную камеру iPhone (это сразу 50–200 МБ на
   30 секунд, 4K/HDR), а писать через getUserMedia + MediaRecorder
   с явно урезанным разрешением и битрейтом. На выходе — 2–5 МБ на
   ролик той же длины.

   ВАЖНО про Safari/iOS: если не задать videoBitsPerSecond явно,
   Safari сама возьмёт битрейт по умолчанию 10 Мбит/с (это ВЫШЕ, чем
   у Chrome/Firefox — 2.5 Мбит/с) — то есть именно на iPhone видео
   получится самым тяжёлым из всех платформ, если это не задать.
   Указанный битрейт браузеры (включая iOS Safari) соблюдают в
   пределах 10–15%, так что этим рычагом можно реально управлять
   размером файла.
   ============================================================ */

(function (global) {
  'use strict';

  var MAX_SECONDS = 60;       // жёсткий потолок длительности ролика (видео живёт в Object Storage —
                               // ограничения по размеру для надёжного проигрывания больше нет)

  /* Три уровня сжатия — выбирает человек перед записью/сжатием файла из
     галереи. "Сильное" = меньше файл и ниже качество, "слабое" = крупнее
     файл и выше качество. Названия — по силе СЖАТИЯ, не по качеству, это
     важно не перепутать при выборе в интерфейсе. */
  var QUALITY = {
    strong: { width: 360, height: 480, bitrate: 350000, label: 'Сильное' },
    medium: { width: 480, height: 640, bitrate: 700000, label: 'Среднее' },
    weak: { width: 640, height: 854, bitrate: 1300000, label: 'Слабое' }
  };
  var DEFAULT_QUALITY = 'medium';

  function qualityOf(key) { return QUALITY[key] || QUALITY[DEFAULT_QUALITY]; }

  function pickMimeType() {
    if (!global.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    /* mp4/H.264 сначала: играет надёжно везде — в Safari, в приложении
       "Фото" на iPhone, в VLC, на Windows, в любом браузере. webm с
       некоторых устройств формально ЗАПИСЫВАЕТСЯ (isTypeSupported даёт
       true), но воспроизведение такого файла за пределами Chrome/Firefox
       — уже не гарантия, особенно на iOS. Берём webm только если mp4
       совсем не поддерживается на запись. */
    var candidates = [
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function extFor(mime) {
    return mime.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
  }

  var Video = {
    supported: function () {
      return !!(global.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && global.MediaRecorder);
    },

    /* Список уровней сжатия для интерфейса — ключ + подпись. */
    qualities: function () {
      return Object.keys(QUALITY).map(function (k) { return { key: k, label: QUALITY[k].label }; });
    },
    defaultQuality: DEFAULT_QUALITY,

    /* Открыть камеру. facing: 'user' (фронтальная) | 'environment' (основная).
       qualityKey: 'strong' | 'medium' | 'weak' — влияет на разрешение,
       которое запрашивается у камеры (битрейт применяется отдельно, в
       startRecording, но разрешение нужно задать уже здесь). */
    openCamera: function (facing, qualityKey) {
      var q = qualityOf(qualityKey);
      var constraints = {
        audio: true, // всегда запрашиваем — чтобы включить/выключить звук можно было
                      // без повторного запроса разрешения камеры, см. setMic()
        video: {
          facingMode: facing || 'environment',
          width: { ideal: q.width },
          height: { ideal: q.height },
          frameRate: { ideal: 24, max: 30 }
        }
      };
      return navigator.mediaDevices.getUserMedia(constraints);
    },

    closeCamera: function (stream) {
      if (!stream) return;
      stream.getTracks().forEach(function (t) { t.stop(); });
    },

    /* Вкл/выкл звук у уже открытого потока — без повторного запроса
       разрешений и без пересоздания камеры. Работает и до записи (для
       переключателя в интерфейсе), и во время неё — MediaRecorder
       уважает track.enabled динамически: выключенная дорожка пишется
       тишиной, а не отсутствует вовсе. */
    setMic: function (stream, enabled) {
      if (!stream) return;
      stream.getAudioTracks().forEach(function (t) { t.enabled = !!enabled; });
    },

    /* Начать запись. onTick(secondsLeft) — раз в секунду, для таймера в UI.
       onDone(blob, ext) — когда запись остановлена (вручную или по лимиту).
       qualityKey — тот же уровень сжатия, что был передан в openCamera(). */
    startRecording: function (stream, onTick, onDone, qualityKey) {
      var q = qualityOf(qualityKey);
      var mime = pickMimeType();
      if (!mime) throw new Error('Браузер не умеет записывать видео (нет MediaRecorder)');

      var opts = { mimeType: mime, videoBitsPerSecond: q.bitrate };
      var rec;
      try {
        rec = new MediaRecorder(stream, opts);
      } catch (e) {
        rec = new MediaRecorder(stream, { mimeType: mime }); // на случай если браузер капризничает на опциях
      }

      var chunks = [];
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        clearInterval(tickTimer);
        clearTimeout(hardStop);
        var blob = new Blob(chunks, { type: mime });
        onDone(blob, extFor(mime));
      };

      /* Без аргумента здесь браузер копит ВСЕ данные видео внутри себя и
         сбрасывает одним куском только в конце записи — на роликах
         длиннее ~20 секунд это на части устройств (замечено на iPhone)
         провоцирует известный баг MediaRecorder: видеодорожка начинает
         терять кадры и "зависает" под давлением на внутренний буфер,
         а аудио продолжает писаться нормально — картинка стоит, звук
         идёт. Периодический сброс каждую секунду устраняет накопление
         буфера и сам баг. */
      rec.start(1000);

      var left = MAX_SECONDS;
      if (onTick) onTick(left);
      var tickTimer = setInterval(function () {
        left -= 1;
        if (onTick) onTick(Math.max(0, left));
      }, 1000);

      var hardStop = setTimeout(function () {
        if (rec.state === 'recording') rec.stop();
      }, MAX_SECONDS * 1000);

      return {
        stop: function () { if (rec.state === 'recording') rec.stop(); },
        maxSeconds: MAX_SECONDS
      };
    },

    /* Сжать готовый файл из галереи до того же порядка размера, что и
       живая запись: кадры перерисовываются на canvas, звук — через Web
       Audio (MediaElementSource), результат пишется тем же MediaRecorder
       с тем же битрейтом и обрезкой по времени.

       В первой версии эта функция один раз выдала на конкретном
       устройстве пустой (0 КБ) результат без единой ошибки — самое
       неприятное, что может сделать сжатие: молча притвориться, что всё
       получилось. Поэтому здесь ЖЁСТКАЯ проверка: если итоговый blob
       пустой или подозрительно маленький для заявленной длительности —
       Вызывающий код обязан на onError просто отправить файл как есть,
       без сжатия — тогда либо получится заметно быстрее, либо в
       худшем случае не хуже, чем было, но никогда не приведёт к
       отправке битого файла.

       onTick(secondsLeft) — примерная оценка, сколько ещё обрабатывать.
       onDone(blob, ext) / onError(err). */
    compressFile: function (file, onTick, onDone, onError, qualityKey) {
      if (!file || !file.type || file.type.indexOf('video') !== 0) {
        onError(new Error('Выбранный файл — не видео'));
        return;
      }
      var q = qualityOf(qualityKey);

      var src = document.createElement('video');
      src.muted = false;
      src.playsInline = true;
      src.src = URL.createObjectURL(file);

      var settled = false;
      function fail(err) {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(src.src);
        onError(err);
      }

      src.onerror = function () { fail(new Error('Не удалось прочитать это видео')); };

      src.onloadedmetadata = function () {
        try {
          var srcW = src.videoWidth || q.width;
          var srcH = src.videoHeight || q.height;
          var maxSide = Math.max(q.width, q.height);
          var scale = Math.min(1, maxSide / Math.max(srcW, srcH));
          var cw = Math.max(2, Math.round(srcW * scale));
          var ch = Math.max(2, Math.round(srcH * scale));

          var canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          var ctx = canvas.getContext('2d');

          var combined;
          var AudioCtx = global.AudioContext || global.webkitAudioContext;
          if (AudioCtx) {
            var actx = new AudioCtx();
            if (actx.resume) actx.resume().catch(function () {});
            var srcNode = actx.createMediaElementSource(src);
            var dest = actx.createMediaStreamDestination();
            srcNode.connect(dest);
            var canvasStream = canvas.captureStream(24);
            combined = new MediaStream(canvasStream.getVideoTracks().concat(dest.stream.getAudioTracks()));
          } else {
            combined = canvas.captureStream(24); // без звука — если Web Audio недоступен
          }

          var mime = pickMimeType();
          if (!mime) throw new Error('Браузер не умеет обрабатывать видео (нет MediaRecorder)');
          var opts = { mimeType: mime, videoBitsPerSecond: q.bitrate };
          var rec;
          try { rec = new MediaRecorder(combined, opts); }
          catch (e) { rec = new MediaRecorder(combined, { mimeType: mime }); }

          var chunks = [];
          rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

          var limit = Math.min(src.duration || MAX_SECONDS, MAX_SECONDS);
          var raf = null;

          function finish() {
            if (settled) return;
            if (raf) cancelAnimationFrame(raf);
            clearTimeout(hardStop);
            src.pause();
            if (rec.state === 'recording') rec.stop();
          }

          function draw() {
            if (src.paused || src.ended) return;
            ctx.drawImage(src, 0, 0, cw, ch);
            if (onTick) onTick(Math.max(0, Math.ceil(limit - src.currentTime)));
            raf = requestAnimationFrame(draw);
          }

          rec.onstop = function () {
            if (settled) return;
            settled = true;
            URL.revokeObjectURL(src.src);
            var blob = new Blob(chunks, { type: mime });
            /* Минимальная разумная планка: даже 1 секунда на нашем
               битрейте — это десятки КБ. Пустой или крошечный результат
               значит, что сжатие не задалось (это уже случалось), а не
               что ролик был очень коротким. */
            var minBytes = Math.max(8 * 1024, (q.bitrate / 8) * Math.min(limit, 1) * 0.3);
            if (blob.size < minBytes) {
              onError(new Error('Сжатие дало пустой результат (' + Math.round(blob.size / 1024) + ' КБ) — похоже на баг браузера'));
              return;
            }
            onDone(blob, extFor(mime));
          };

          src.onended = finish;
          var hardStop = setTimeout(finish, limit * 1000 + 300);

          rec.start(1000); // периодический сброс — та же причина, см. комментарий в startRecording()
          var playPromise = src.play();
          if (playPromise && playPromise.catch) {
            playPromise.catch(function (e) { fail(new Error('Браузер не разрешил обработку: ' + e.message)); });
          }
          draw();
        } catch (e) {
          fail(e);
        }
      };
    }
  };

  global.PCVideo = Video;
})(window);
