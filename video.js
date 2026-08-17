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

  var MAX_SECONDS = 35;       // жёсткий потолок длительности ролика
  var TARGET_BITRATE = 700000; // ~700 кбит/с — для 35 сек это ~3 МБ
  var TARGET_WIDTH = 480;
  var TARGET_HEIGHT = 640;

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

    /* Открыть камеру. facing: 'user' (фронтальная) | 'environment' (основная). */
    openCamera: function (facing) {
      var constraints = {
        audio: true,
        video: {
          facingMode: facing || 'environment',
          width: { ideal: TARGET_WIDTH },
          height: { ideal: TARGET_HEIGHT },
          frameRate: { ideal: 24, max: 30 }
        }
      };
      return navigator.mediaDevices.getUserMedia(constraints);
    },

    closeCamera: function (stream) {
      if (!stream) return;
      stream.getTracks().forEach(function (t) { t.stop(); });
    },

    /* Начать запись. onTick(secondsLeft) — раз в секунду, для таймера в UI.
       onDone(blob, ext) — когда запись остановлена (вручную или по лимиту). */
    startRecording: function (stream, onTick, onDone) {
      var mime = pickMimeType();
      if (!mime) throw new Error('Браузер не умеет записывать видео (нет MediaRecorder)');

      var opts = { mimeType: mime, videoBitsPerSecond: TARGET_BITRATE };
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

      rec.start();

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
    }
  };

  global.PCVideo = Video;
})(window);
