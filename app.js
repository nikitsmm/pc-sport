/* ============================================================
   ПЦ Спорт — логика приложения
   ============================================================ */
(function () {
  'use strict';

  /* ---------- значения по умолчанию ---------- */
  var DEFAULTS = {
    version: 1,
    updatedAt: null,
    anchor: '2026-08-17',   // в этот день чередующиеся делают подтягивания
    fine: 5000,
    altLimit: 2,
    maxMult: 4,
    deadline: '23:59:59',
    participants: [
      { id: 'kolya', name: 'Коля',  mode: 'alt',   pullups: 60, pushups: 70, leftAt: null },
      { id: 'vanya', name: 'Ваня',  mode: 'alt',   pullups: 50, pushups: 60, leftAt: null },
      { id: 'artur', name: 'Артур', mode: 'daily', ex: 'pushups', reps: 50,  leftAt: null },
      { id: 'anton', name: 'Антон', mode: 'daily', ex: 'pushups', reps: 40,  leftAt: null }
    ],
    days: {}
  };

  var STATUSES = ['done', 'alt', 'forgiven', 'missed'];
  var CYCLE = [null, 'done', 'alt', 'forgiven', 'missed'];
  var LABEL = { done: 'Норма', alt: 'Альт', forgiven: 'Форс', missed: 'Пропуск' };
  var GLYPH = { done: '✓', alt: '⇄', forgiven: '⚑', missed: '✕' };
  var EXNAME = { pullups: 'подтягиваний', pushups: 'отжиманий' };

  var state = null;
  var cursor = null;      // текущая дата на вкладке «Сегодня»
  var saveTimer = null;
  var videoIndex = { items: [], retentionDays: 0 };  // кэш ответа list_videos
  var recSession = null;  // { stream, ctrl, participantId, date, blob, ext }
  var chatMessages = [];  // все известные сообщения, отсортированные по времени
  var chatPollTimer = null;
  var chatSending = false;

  /* ============================================================
     Даты
     ============================================================ */
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function parse(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2], 12, 0, 0);
  }
  function today() { return iso(new Date()); }
  function shift(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
  function diffDays(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function human(s) {
    var d = parse(s);
    var m = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    var w = ['воскресенье','понедельник','вторник','среда','четверг','пятница','суббота'];
    return d.getDate() + ' ' + m[d.getMonth()] + ', ' + w[d.getDay()];
  }
  function shortDate(s) {
    var d = parse(s);
    var w = ['вс','пн','вт','ср','чт','пт','сб'];
    return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + ' ' + w[d.getDay()];
  }
  function isWeekend(s) { var g = parse(s).getDay(); return g === 0 || g === 6; }
  function mondayOf(s) { var d = parse(s); var g = (d.getDay() + 6) % 7; return shift(s, -g); }
  function money(n) {
    var neg = n < 0, v = Math.abs(n);
    var str = v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    str = str.replace(/,00$/, '');
    return (neg ? '−' : '') + str + ' ₽';
  }

  /* ============================================================
     Правила
     ============================================================ */
  function activeOn(p, date) { return !p.leftAt || p.leftAt > date; }
  function activeList(date) { return state.participants.filter(function (p) { return activeOn(p, date); }); }

  /* Что делает участник в этот день без учёта отработки. */
  function baseTask(p, date) {
    if (p.mode === 'alt') {
      var n = ((diffDays(state.anchor, date) % 2) + 2) % 2;
      return n === 0 ? { ex: 'pullups', reps: p.pullups } : { ex: 'pushups', reps: p.pushups };
    }
    return { ex: p.ex || 'pushups', reps: p.reps };
  }

  /* Сколько дней подряд перед этой датой были признаны форс-мажором. */
  function forgivenStreak(p, date) {
    var n = 0, d = shift(date, -1);
    while (n < 30) {
      var rec = state.days[d] && state.days[d][p.id];
      if (rec && rec.status === 'forgiven') { n++; d = shift(d, -1); } else break;
    }
    return n;
  }
  function multiplier(p, date) {
    return Math.min(forgivenStreak(p, date) + 1, state.maxMult);
  }
  function task(p, date) {
    var t = baseTask(p, date), m = multiplier(p, date);
    return { ex: t.ex, base: t.reps, mult: m, reps: t.reps * m };
  }

  function statusOf(p, date) {
    var rec = state.days[date] && state.days[date][p.id];
    return rec ? rec.status : null;
  }
  function setStatus(p, date, status) {
    if (!state.days[date]) state.days[date] = {};
    if (!status) delete state.days[date][p.id];
    else state.days[date][p.id] = { status: status, at: new Date().toISOString() };
    if (!Object.keys(state.days[date]).length) delete state.days[date];
    commit();
  }

  /* Сколько альтернатив израсходовано на неделе этой даты. */
  function altUsed(p, date) {
    var mon = mondayOf(date), n = 0;
    for (var i = 0; i < 7; i++) {
      var d = shift(mon, i);
      if (statusOf(p, d) === 'alt') n++;
    }
    return n;
  }

  /* ---------- штрафы ---------- */
  function fineEvents() {
    var out = [];
    Object.keys(state.days).sort().forEach(function (date) {
      state.participants.forEach(function (p) {
        var rec = state.days[date][p.id];
        if (rec && rec.status === 'missed') out.push({ date: date, payer: p.id, reason: 'Пропуск без уважительной причины' });
      });
    });
    state.participants.forEach(function (p) {
      if (p.leftAt) out.push({ date: p.leftAt, payer: p.id, reason: 'Добровольный выход' });
    });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }

  function ledger() {
    var bal = {}, paid = {}, got = {};
    state.participants.forEach(function (p) { bal[p.id] = 0; paid[p.id] = 0; got[p.id] = 0; });
    var events = fineEvents(), total = 0;

    events.forEach(function (e) {
      /* делим на тех, кто участвует в челлендже в день штрафа */
      var others = activeList(e.date).filter(function (p) { return p.id !== e.payer; });
      if (!others.length) return;                     // делить не на кого — штраф не начисляется
      var share = state.fine / others.length;
      bal[e.payer] -= state.fine;
      paid[e.payer] += state.fine;
      others.forEach(function (p) { bal[p.id] += share; got[p.id] += share; });
      total += state.fine;
      e.share = share;
      e.to = others.map(function (p) { return p.name; });
    });
    return { balance: bal, paid: paid, got: got, events: events, total: total };
  }

  /* ============================================================
     Хранение
     ============================================================ */
  function commit() {
    state.updatedAt = new Date().toISOString();
    Storage.writeLocal(state);
    render();
    clearTimeout(saveTimer);
    setSyncDot('pending');
    saveTimer = setTimeout(function () {
      PCLog.info('Сохраняю изменения на Диск…');
      Storage.push(state).then(function (r) {
        if (r && r.synced) {
          PCLog.info('Сохранено на Диск');
          setCfgStatus('Выгружено на Яндекс.Диск', 'ok');
          setSyncDot('ok');
        } else {
          setSyncDot('local');
        }
      }).catch(function (e) {
        PCLog.error('Не удалось сохранить на Диск: ' + e.message);
        setCfgStatus(e.message, 'err');
        setSyncDot('err');
      });
    }, 900);
  }

  function setSyncDot(state) {
    var el = $('#sync-dot');
    if (!el) return;
    el.className = 'sync-dot ' + state;
    el.title = { pending: 'Сохраняю…', ok: 'Сохранено на Диске', local: 'Только локально', err: 'Ошибка сохранения' }[state] || '';
  }

  function normalize(s) {
    var out = JSON.parse(JSON.stringify(DEFAULTS));
    if (s && typeof s === 'object') {
      Object.keys(DEFAULTS).forEach(function (k) { if (s[k] !== undefined) out[k] = s[k]; });
      if (!Array.isArray(out.participants) || !out.participants.length) out.participants = DEFAULTS.participants;
      if (!out.days || typeof out.days !== 'object') out.days = {};
    }
    return out;
  }

  /* ============================================================
     Отрисовка — Сегодня
     ============================================================ */
  var $ = function (s) { return document.querySelector(s); };

  function renderToday() {
    var date = cursor;
    $('#d-label').textContent = (date === today() ? 'Сегодня — ' : '') + human(date);
    $('#d-next').disabled = date >= today();

    var host = $('#today-cards');
    host.innerHTML = '';

    state.participants.forEach(function (p) {
      var gone = !activeOn(p, date);
      var t = task(p, date);
      var st = statusOf(p, date);
      var used = altUsed(p, date);

      var card = document.createElement('div');
      card.className = 'card' + (gone ? ' gone' : '');

      var badges = '';
      if (t.mult > 1) badges += '<span class="badge mult' + (t.mult >= 4 ? ' m4' : t.mult === 3 ? ' m3' : '') + '">Отработка ×' + t.mult + '</span>';
      if (st) badges += ' <span class="badge ' + st + '">' + LABEL[st] + '</span>';

      var body =
        '<div class="head"><div class="name">' + p.name + '</div><div>' + badges + '</div></div>' +
        '<div class="task"><div class="reps">' + (gone ? '—' : t.reps) + '</div>' +
        '<div class="ex">' + (gone ? 'вышел из челленджа' : EXNAME[t.ex] + (t.mult > 1 ? ' (' + t.base + ' × ' + t.mult + ')' : '')) + '</div></div>';

      if (!gone) {
        body += '<div class="status-row">' + STATUSES.map(function (s) {
          return '<button data-p="' + p.id + '" data-s="' + s + '" class="' + (st === s ? 'sel s-' + s : '') + '">' +
                 '<span class="g">' + GLYPH[s] + '</span>' + LABEL[s] + '</button>';
        }).join('') + '</div>';

        var hints = [];
        if (t.mult > 1) hints.push('<span class="warn">Отработка за ' + (t.mult - 1) + ' ' + plural(t.mult - 1, 'признанный', 'признанных', 'признанных') + ' ' + plural(t.mult - 1, 'день', 'дня', 'дней') + ' форс-мажора.</span>');
        if (st === 'alt' || used) {
          var over = used > state.altLimit;
          hints.push('Альтернативы на неделе: <b>' + used + ' из ' + state.altLimit + '</b>' + (over ? ' — лимит превышен' : ''));
        }
        if (st === 'missed') hints.push('<span class="warn">Штраф ' + money(state.fine) + ' — делится между остальными.</span>');
        if (st === 'forgiven') hints.push('Штрафа нет. Завтра норма ×' + Math.min(forgivenStreak(p, shift(date, 1)) + 1, state.maxMult) + '.');
        if (hints.length) body += '<div class="hint">' + hints.join('<br>') + '</div>';
      }

      card.innerHTML = body;
      host.appendChild(card);
    });

    host.querySelectorAll('.status-row button').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = state.participants.filter(function (x) { return x.id === b.dataset.p; })[0];
        setStatus(p, cursor, statusOf(p, cursor) === b.dataset.s ? null : b.dataset.s);
      });
    });

    var left = state.participants.filter(function (p) { return p.leftAt; });
    $('#today-banner').innerHTML = left.length
      ? '<div class="empty" style="margin-top:12px;border-color:var(--signal);color:var(--signal)">Челлендж завершён: ' +
        left.map(function (p) { return p.name; }).join(', ') + ' вышел ' + shortDate(left[0].leftAt) + '.</div>'
      : '';

    renderVideos();
  }

  /* ============================================================
     Видео дня
     ============================================================ */
  function renderVideos() {
    var host = $('#today-videos');
    if (!host) return;
    var date = cursor;
    var canRecord = Storage.video.supported() && PCVideo.supported();

    if (!Storage.video.supported()) {
      host.innerHTML = '<div class="empty">Видео работают только при включённой облачной синхронизации — настрой её на вкладке «Настройки».</div>';
      return;
    }

    host.innerHTML = state.participants.map(function (p) {
      var gone = !activeOn(p, date);
      var clips = videoIndex.items.filter(function (v) { return v.participantId === p.id && v.date === date; });
      var thumbs = clips.map(function (v) {
        return '<button class="vid-thumb" data-play="' + v.path + '" data-who="' + p.name + '" title="Смотреть">▶</button>';
      }).join('');
      var addBtn = (!gone && canRecord)
        ? '<button class="vid-add" data-rec="' + p.id + '" title="Записать видео">＋</button>'
        : '';
      return '<div class="vid-row"><div class="who">' + p.name + '</div><div class="clips">' + thumbs + addBtn + '</div></div>';
    }).join('');

    if (videoIndex.retentionDays) {
      host.insertAdjacentHTML('beforeend', '<p class="vid-empty-hint">Видео хранятся ' + videoIndex.retentionDays + ' ' +
        plural(videoIndex.retentionDays, 'день', 'дня', 'дней') + ', потом удаляются автоматически.</p>');
    }

    host.querySelectorAll('[data-rec]').forEach(function (b) {
      b.addEventListener('click', function () { openRecorder(b.dataset.rec); });
    });
    host.querySelectorAll('[data-play]').forEach(function (b) {
      b.addEventListener('click', function () { openPlayer(b.dataset.play, b.dataset.who); });
    });
  }

  function refreshVideoIndex() {
    if (!Storage.video.supported()) return Promise.resolve();
    return Storage.video.list().then(function (r) {
      videoIndex = r || { items: [], retentionDays: 0 };
      renderVideos();
      if (r && r.healed) {
        setCfgStatus('Досчитал ' + r.healed + ' ' + plural(r.healed, 'пропущенное видео', 'пропущенных видео', 'пропущенных видео') + ' с Диска', 'ok');
      }
    }).catch(function () { /* тихо: список не критичен для остального интерфейса */ });
  }

  /* ---------- запись ---------- */
  function openRecorder(participantId) {
    var p = state.participants.filter(function (x) { return x.id === participantId; })[0];
    if (!p) return;
    recSession = { participantId: participantId, date: cursor, facing: 'environment', recording: false };

    $('#rec-who').textContent = p.name + ' · ' + shortDate(cursor);
    $('#rec-msg').textContent = '';
    $('#rec-live').hidden = false;
    $('#rec-preview').hidden = true;
    $('#rec-preview').src = '';
    $('#rec-timer').hidden = true;
    $('#rec-live-controls').hidden = false;
    $('#rec-controls-preview').hidden = true;
    setToggleIdle();
    $('#rec-toggle').disabled = true;
    $('#rec-flip').disabled = true;
    $('#rec-gallery').disabled = false;

    $('#recOverlay').classList.add('on');

    PCVideo.openCamera(recSession.facing).then(function (stream) {
      recSession.stream = stream;
      $('#rec-live').srcObject = stream;
      $('#rec-toggle').disabled = false;
      $('#rec-flip').disabled = false;
    }).catch(function (e) {
      $('#rec-msg').textContent = 'Нет доступа к камере: ' + e.message + ' Можно взять готовое видео из галереи.';
    });
  }

  function closeRecorder() {
    if (recSession) {
      if (recSession.ctrl) recSession.ctrl.stop();
      PCVideo.closeCamera(recSession.stream);
    }
    recSession = null;
    $('#recOverlay').classList.remove('on');
  }

  function setToggleIdle() {
    var b = $('#rec-toggle');
    b.textContent = '● Запись';
    b.classList.remove('active');
  }

  function toggleRecordingUI() {
    if (!recSession || !recSession.stream) return;
    if (recSession.recording) {
      if (recSession.ctrl) recSession.ctrl.stop();
      return;
    }
    recSession.recording = true;
    $('#rec-toggle').classList.add('active');
    $('#rec-flip').disabled = true;
    $('#rec-gallery').disabled = true;
    $('#rec-timer').hidden = false;

    recSession.ctrl = PCVideo.startRecording(
      recSession.stream,
      function (secLeft) { $('#rec-timer').textContent = '00:' + String(secLeft).padStart(2, '0'); },
      function (blob, ext) {
        recSession.recording = false;
        $('#rec-live').hidden = true;
        $('#rec-timer').hidden = true;
        setToggleIdle();
        showRecordedPreview(blob, ext);
      }
    );
  }

  /* Общий финиш и для живой записи, и для файла из галереи — дальше
     человек видит один и тот же предпросмотр с кнопками
     «Ещё раз» / «Отправить», не важно, откуда взялся ролик. */
  function showRecordedPreview(blob, ext) {
    recSession.blob = blob;
    recSession.ext = ext;
    $('#rec-live-controls').hidden = true;
    $('#rec-controls-preview').hidden = false;
    var preview = $('#rec-preview');
    preview.hidden = false;
    preview.src = URL.createObjectURL(blob);
    var sizeKb = Math.round(blob.size / 1024);
    var sizeStr = sizeKb > 1024 ? (sizeKb / 1024).toFixed(1) + ' МБ' : sizeKb + ' КБ';
    var warn = sizeKb > 15 * 1024 ? ' Файл тяжёлый — загрузка может занять время.' : '';
    $('#rec-msg').textContent = 'Готово, ' + sizeStr + '.' + warn;
  }

  function openGalleryPicker() {
    if (!recSession) return;
    $('#rec-file').click();
  }

  /* Видео из галереи заливается как есть, без пересборки — так надёжнее.
     Гарантия маленького размера — только у записи прямо в приложении. */
  function extForMime(mime) {
    if (!mime) return 'mp4';
    if (mime.indexOf('quicktime') !== -1) return 'mov';
    if (mime.indexOf('webm') !== -1) return 'webm';
    return 'mp4';
  }

  /* Раньше это число было привязано к порогу надёжного проигрывания на
     бэкенде (VIDEO_INLINE_MAX_BYTES) — с переездом видео на Object
     Storage такого порога больше нет, любой размер играет одинаково
     надёжно. Сжатие оставлено чисто ради скорости загрузки на мобильной
     сети — маленький файл заливается быстрее большого, вот и всё. */
  var SKIP_COMPRESS_UNDER = 2.5 * 1024 * 1024;

  function handleGalleryFile(file) {
    if (!file || !recSession) return;
    if (!file.type || file.type.indexOf('video') !== 0) {
      $('#rec-msg').textContent = 'Выбранный файл — не видео.';
      return;
    }
    $('#rec-live').hidden = true;

    if (!PCVideo.supported() || file.size <= SKIP_COMPRESS_UNDER) {
      showRecordedPreview(file, extForMime(file.type));
      return;
    }

    var originalKb = Math.round(file.size / 1024);
    $('#rec-timer').hidden = false;
    $('#rec-timer').textContent = 'обработка…';
    $('#rec-msg').textContent = 'Сжимаю видео из галереи (' + (originalKb / 1024).toFixed(1) + ' МБ) — так загрузится быстрее.';

    PCVideo.compressFile(
      file,
      function (secLeft) { $('#rec-timer').textContent = 'ещё ~' + secLeft + ' с'; },
      function (blob, ext) {
        $('#rec-timer').hidden = true;
        showRecordedPreview(blob, ext);
        var newKb = Math.round(blob.size / 1024);
        $('#rec-msg').textContent += ' Было ' + (originalKb > 1024 ? (originalKb / 1024).toFixed(1) + ' МБ' : originalKb + ' КБ') +
          ' → стало ' + (newKb > 1024 ? (newKb / 1024).toFixed(1) + ' МБ' : newKb + ' КБ') + '.';
      },
      function () {
        /* Сжатие не задалось — не теряем видео, отправляем как есть.
           Единственная жертва — медленнее загрузится, зато гарантированно
           не пустой файл. */
        $('#rec-timer').hidden = true;
        showRecordedPreview(file, extForMime(file.type));
        $('#rec-msg').textContent = 'Не получилось сжать — отправлю как есть, может занять больше времени.';
      }
    );
  }

  function retakeUI() {
    var preview = $('#rec-preview');
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.src = '';
    preview.hidden = true;
    $('#rec-live').hidden = false;
    $('#rec-controls-preview').hidden = true;
    $('#rec-live-controls').hidden = false;
    $('#rec-flip').disabled = false;
    $('#rec-gallery').disabled = false;
    $('#rec-msg').textContent = '';
  }

  function sendRecordingUI() {
    if (!recSession || !recSession.blob) return;
    var s = recSession;
    var who = participantName(s.participantId);
    $('#rec-controls-preview').hidden = true;
    $('#rec-msg').textContent = 'Отправляю… 0%';

    PCLog.info('Видео: начинаю загрузку (' + who + ', ' + shortDate(s.date) + ', ' + Math.round(s.blob.size / 1024) + ' КБ)');
    chatAnnounce(s.participantId, '🎥 Начал загрузку видео на Диск…');

    var slowHint = setTimeout(function () {
      $('#rec-msg').textContent += ' (Яндекс.Диску иногда нужно чуть больше времени на обработку — это ещё не зависание)';
    }, 20000);

    Storage.video.upload(
      s.participantId, s.date, s.blob, s.ext,
      function (frac) { $('#rec-msg').textContent = 'Отправляю… ' + Math.round(frac * 100) + '%'; },
      function (phase) { $('#rec-msg').textContent = phase; }
    ).then(function (r) {
      clearTimeout(slowHint);
      $('#rec-msg').textContent = r.confirmed
        ? 'Отправлено'
        : 'Файл на Диске, но подтверждение задержалось — появится в списке само';
      PCLog.info('Видео: загружено (' + who + ', confirmed=' + r.confirmed + ')');
      chatAnnounce(s.participantId, '✅ Загрузил видео на Диск' + (r.confirmed ? '' : ' (появится в списке чуть позже)'));
      setTimeout(function () {
        closeRecorder();
        refreshVideoIndex();
      }, r.confirmed ? 500 : 1500);
    }).catch(function (e) {
      clearTimeout(slowHint);
      $('#rec-msg').textContent = 'Не отправилось: ' + e.message;
      $('#rec-controls-preview').hidden = false;
      PCLog.error('Видео: загрузка не удалась (' + who + '): ' + e.message);
      chatAnnounce(s.participantId, '⚠️ Не получилось загрузить видео: ' + e.message);
    });
  }

  /* ---------- просмотр ---------- */
  function openPlayer(path, who) {
    $('#play-who').textContent = who || '—';
    $('#play-video').src = '';
    $('#play-msg').textContent = 'Загружаю…';
    $('#play-fallback').href = '#';
    $('#playOverlay').classList.add('on');
    Storage.video.playUrl(path).then(function (r) {
      $('#play-video').src = r.url;
      $('#play-fallback').href = r.url;
      $('#play-msg').textContent = '';
    }).catch(function (e) {
      $('#play-msg').textContent = 'Ошибка: ' + e.message;
    });
  }

  function closePlayer() {
    var v = $('#play-video');
    v.pause();
    v.src = '';
    $('#play-msg').textContent = '';
    $('#playOverlay').classList.remove('on');
  }

  /* ============================================================
     Чат
     ============================================================ */
  var LS_LAST_READ = 'pcsport.chatLastRead';

  function participantName(id) {
    var p = state.participants.filter(function (x) { return x.id === id; })[0];
    return p ? p.name : id;
  }

  function renderWhoPicker(hostSel, selectedId, onPick) {
    var host = $(hostSel);
    host.innerHTML = state.participants.map(function (p) {
      return '<button data-id="' + p.id + '" class="' + (p.id === selectedId ? 'on' : '') + '">' + p.name + '</button>';
    }).join('');
    host.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { onPick(b.dataset.id); });
    });
  }

  function renderChat() {
    var myId = Storage.identity.read();
    var known = state.participants.some(function (p) { return p.id === myId; });

    $('#chat-noauth').hidden = known;
    $('#chat-wrap').hidden = !known;

    if (!known) {
      renderWhoPicker('#chat-who-pick', myId, function (id) {
        Storage.identity.write(id);
        PCLog.info('Выбрана идентичность в чате: ' + id);
        renderChat();
      });
      return;
    }

    var log = $('#chat-log');
    var wasAtBottom = (log.scrollHeight - log.scrollTop - log.clientHeight) < 60;

    var lastDay = '';
    log.innerHTML = chatMessages.map(function (m) {
      var day = m.at ? m.at.slice(0, 10) : '';
      var sep = '';
      if (day && day !== lastDay) { sep = '<div class="chat-day">' + shortDate(day) + '</div>'; lastDay = day; }
      var mine = m.participantId === myId;
      var time = m.at ? m.at.slice(11, 16) : '';
      var cls = 'chat-msg' + (mine ? ' mine' : '') + (m.pending ? ' pending' : '');
      return sep + '<div class="' + cls + '">' +
        (mine ? '' : '<div class="who">' + esc(participantName(m.participantId)) + '</div>') +
        '<div class="txt">' + esc(m.text) + '</div>' +
        '<div class="t">' + time + (m.pending ? ' · отправка…' : '') + '</div></div>';
    }).join('');

    if (wasAtBottom) log.scrollTop = log.scrollHeight;
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function chatMerge(items) {
    if (!items || !items.length) return false;
    var byId = {};
    chatMessages.forEach(function (m) { byId[m.id] = m; });
    var added = false;
    items.forEach(function (m) {
      if (!byId[m.id]) { chatMessages.push(m); byId[m.id] = m; added = true; }
    });
    if (added) {
      chatMessages.sort(function (a, b) { return (a.at || '') < (b.at || '') ? -1 : 1; });
      Storage.chat.writeCache(chatMessages);
    }
    return added;
  }

  function pollChat(isInitial) {
    var cfg = Storage.config.read();
    if (cfg.backend !== 'cloud' || !cfg.url) return Promise.resolve();
    var since = chatMessages.length ? chatMessages[chatMessages.length - 1].id : null;
    return Storage.chat.fetch(isInitial ? null : since).then(function (r) {
      var items = (r && r.items) || [];
      var myId = Storage.identity.read();
      var newFromOthers = items.filter(function (m) {
        return !chatMessages.some(function (x) { return x.id === m.id; }) && m.participantId !== myId;
      });
      var changed = chatMerge(items);
      if (changed) {
        var onChatTab = document.getElementById('v-chat').classList.contains('on');
        if (onChatTab && !document.hidden) {
          markChatRead();
          renderChat();
        } else if (newFromOthers.length) {
          bumpChatUnread(newFromOthers.length);
          notifyNewMessages(newFromOthers);
        }
      }
    }).catch(function (e) { PCLog.warn('Чат: не удалось обновить — ' + e.message); });
  }

  function startChatPolling() {
    stopChatPolling();
    pollChat(true);
    chatPollTimer = setInterval(function () { pollChat(false); }, 8000);
  }
  function stopChatPolling() {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }

  function bumpChatUnread(n) {
    var dot = $('#chat-dot');
    if (!dot) return;
    var count = (parseInt(dot.textContent, 10) || 0) + n;
    dot.textContent = String(count);
    dot.hidden = false;
  }

  function markChatRead() {
    var dot = $('#chat-dot');
    if (dot) { dot.hidden = true; dot.textContent = ''; }
    try { localStorage.setItem(LS_LAST_READ, chatMessages.length ? chatMessages[chatMessages.length - 1].id : ''); } catch (e) {}
  }

  function notifyNewMessages(items) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return; // приложение и так на экране — хватит бейджа
    try {
      var last = items[items.length - 1];
      var title = items.length > 1 ? ('Чат ПЦ Спорт · ' + items.length + ' новых') : ('Чат ПЦ Спорт · ' + participantName(last.participantId));
      var n = new Notification(title, { body: last.text, tag: 'pcsport-chat' });
      n.onclick = function () { window.focus(); };
    } catch (e) { PCLog.warn('Notification: ' + e.message); }
  }

  function sendChatMessage(text) {
    var myId = Storage.identity.read();
    text = (text || '').trim();
    if (!text || !myId) return Promise.resolve();
    var tempId = 'tmp-' + Date.now();
    var optimistic = { id: tempId, participantId: myId, text: text, at: new Date().toISOString(), pending: true };
    chatMessages.push(optimistic);
    renderChat();
    var log = $('#chat-log');
    if (log) log.scrollTop = log.scrollHeight;
    return Storage.chat.send(myId, text).then(function (msg) {
      chatMessages = chatMessages.filter(function (m) { return m.id !== tempId; });
      chatMerge([msg]);
      renderChat();
    }).catch(function (e) {
      PCLog.error('Чат: сообщение не отправилось — ' + e.message);
      var m = chatMessages.filter(function (x) { return x.id === tempId; })[0];
      if (m) { m.pending = false; m.failed = true; m.text += '  [не отправлено]'; }
      renderChat();
    });
  }

  /* Автосообщения о видео — от лица того, кто грузит, не от «бота»:
     так в чате видно и факт, и кто именно снимал. Отправка не должна
     мешать самой загрузке видео, поэтому без await и без остановки
     процесса при сбое. */
  function chatAnnounce(participantId, text) {
    Storage.chat.send(participantId, text).catch(function (e) { PCLog.warn('Чат-уведомление не ушло: ' + e.message); });
  }

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  /* ============================================================
     Отрисовка — Журнал
     ============================================================ */
  function renderLog() {
    var days = 21, rows = [], t = today();
    var head = '<thead><tr><th style="text-align:left;padding-left:8px">Дата</th>' +
      state.participants.map(function (p) { return '<th>' + p.name + '</th>'; }).join('') + '</tr></thead>';

    for (var i = 0; i < days; i++) {
      var d = shift(t, -i);
      var cells = state.participants.map(function (p) {
        if (!activeOn(p, d)) return '<td><button disabled class="cell-none">·</button></td>';
        var st = statusOf(p, d);
        return '<td><button data-p="' + p.id + '" data-d="' + d + '" class="cell-' + (st || 'none') + '">' +
               (st ? GLYPH[st] : '·') + '</button></td>';
      }).join('');
      rows.push('<tr class="' + (isWeekend(d) ? 'we' : '') + '"><td class="d">' + shortDate(d) + '</td>' + cells + '</tr>');
    }

    var table = $('#log-table');
    table.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';
    table.querySelectorAll('button[data-p]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = state.participants.filter(function (x) { return x.id === b.dataset.p; })[0];
        var cur = statusOf(p, b.dataset.d);
        var next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
        setStatus(p, b.dataset.d, next);
      });
    });
  }

  /* ============================================================
     Отрисовка — Счёт
     ============================================================ */
  function renderMoney() {
    var L = ledger();

    var sumEl = $('#ql-money-sum');
    if (sumEl) {
      sumEl.textContent = L.total ? money(L.total) : 'Счёт: 0';
      sumEl.className = L.total ? 'owe' : 'zero';
    }

    $('#ledger').innerHTML = state.participants.map(function (p) {
      var v = L.balance[p.id] || 0;
      var cls = v > 0.001 ? 'plus' : v < -0.001 ? 'minus' : 'zero';
      var sub = L.paid[p.id] ? 'Заплатил ' + money(L.paid[p.id]) : 'Штрафов нет';
      if (L.got[p.id]) sub += ' · получил ' + money(L.got[p.id]);
      return '<div class="lrow"><div><div class="who">' + p.name + '</div><div class="sub">' + sub + '</div></div>' +
             '<div class="sum ' + cls + '">' + (v > 0 ? '+' : '') + money(v) + '</div></div>';
    }).join('');

    $('#ledger-total').innerHTML = '<span>Всего штрафов</span><b>' + money(L.total) + '</b>';

    $('#fines-list').innerHTML = L.events.length
      ? '<div class="ledger">' + L.events.slice().reverse().map(function (e) {
          var p = state.participants.filter(function (x) { return x.id === e.payer; })[0];
          return '<div class="lrow"><div><div class="who">' + (p ? p.name : e.payer) + '</div>' +
                 '<div class="sub">' + shortDate(e.date) + ' · ' + e.reason + '<br>по ' + money(e.share) +
                 ' → ' + (e.to || []).join(', ') + '</div></div>' +
                 '<div class="sum minus">' + money(state.fine) + '</div></div>';
        }).join('') + '</div>'
      : '<div class="empty">Штрафов пока нет. Так держать.</div>';
  }

  /* ============================================================
     Отрисовка — Настройки
     ============================================================ */
  function renderLogBox() {
    var box = $('#log-box');
    if (!box) return;
    var lines = PCLog.all();
    box.innerHTML = lines.length
      ? lines.slice(-100).map(function (e) {
          var cls = e.level === 'error' ? ' lvl-error' : e.level === 'warn' ? ' lvl-warn' : '';
          return '<div class="' + cls + '">[' + PCLog.fmtTime(e.t) + '] ' + esc(e.msg) + '</div>';
        }).join('')
      : '<div style="opacity:.5">Пока пусто.</div>';
    box.scrollTop = box.scrollHeight;
  }

  function renderCfg() {
    renderLogBox();
    var cfg = Storage.config.read();
    $('#cfg-backend').value = cfg.backend;
    $('#cfg-url').value = cfg.url || '';
    $('#cfg-cloud').hidden = cfg.backend !== 'cloud';
    $('#cfg-anchor').value = state.anchor;
    $('#cfg-version').textContent = 'Обновлено: ' + (state.updatedAt ? new Date(state.updatedAt).toLocaleString('ru-RU') : 'ещё не сохранялось');

    $('#cfg-people').innerHTML = state.participants.map(function (p) {
      var fields = p.mode === 'alt'
        ? '<div class="row"><div style="flex:1"><label>Подтягивания</label><input type="number" min="1" data-f="pullups" data-p="' + p.id + '" value="' + p.pullups + '"></div>' +
          '<div style="flex:1"><label>Отжимания</label><input type="number" min="1" data-f="pushups" data-p="' + p.id + '" value="' + p.pushups + '"></div></div>'
        : '<label>Отжимания каждый день</label><input type="number" min="1" data-f="reps" data-p="' + p.id + '" value="' + p.reps + '">';
      return '<div style="padding-bottom:16px;margin-bottom:16px;border-bottom:1px solid var(--rule)">' +
             '<div class="who" style="font-family:Unbounded,sans-serif;font-weight:600;text-transform:uppercase;font-size:14px">' + p.name + '</div>' +
             fields +
             '<label>Вышел из челленджа</label><input type="date" data-f="leftAt" data-p="' + p.id + '" value="' + (p.leftAt || '') + '">' +
             '</div>';
    }).join('');

    $('#cfg-people').querySelectorAll('input[data-p]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var p = state.participants.filter(function (x) { return x.id === inp.dataset.p; })[0];
        var f = inp.dataset.f;
        if (f === 'leftAt') p.leftAt = inp.value || null;
        else p[f] = Math.max(1, parseInt(inp.value, 10) || 1);
        commit();
      });
    });
  }

  function setCfgStatus(msg, kind) {
    var el = $('#cfg-status');
    el.textContent = msg || '';
    el.className = 'status-line' + (kind ? ' ' + kind : '');
  }

  /* ============================================================
     Часы
     ============================================================ */
  function tick() {
    var now = new Date();
    var end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    var left = Math.max(0, Math.floor((end - now) / 1000));
    var h = String(Math.floor(left / 3600)).padStart(2, '0');
    var m = String(Math.floor(left % 3600 / 60)).padStart(2, '0');
    var s = String(left % 60).padStart(2, '0');
    var el = $('#clock');
    el.innerHTML = '<b>' + h + ':' + m + ':' + s + '</b>до дедлайна';
    el.className = 'clock' + (left < 3600 ? ' late' : '');
  }

  /* ============================================================
     Общая отрисовка и навигация
     ============================================================ */
  function render() {
    renderToday();
    renderLog();
    renderMoney();
    renderCfg();
    renderChat();
  }

  function show(view) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('on'); });
    $('#v-' + view).classList.add('on');
    document.querySelectorAll('[data-view]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.view === view);
    });
    window.scrollTo(0, 0);
    if (view === 'chat') {
      markChatRead();
      renderChat();
      startChatPolling();
    } else {
      stopChatPolling();
    }
  }

  function bind() {
    document.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.view); });
    });

    $('#chat-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var inp = $('#chat-text');
      var text = inp.value;
      if (!text.trim() || chatSending) return;
      chatSending = true;
      inp.value = '';
      sendChatMessage(text).finally(function () { chatSending = false; });
    });

    $('#cfg-notify').addEventListener('click', function () {
      var st = $('#cfg-notify-status');
      if (!('Notification' in window)) { st.textContent = 'Браузер не поддерживает уведомления'; st.className = 'status-line err'; return; }
      Notification.requestPermission().then(function (perm) {
        if (perm === 'granted') { st.textContent = 'Включено'; st.className = 'status-line ok'; PCLog.info('Уведомления разрешены'); }
        else { st.textContent = 'Не разрешено в браузере'; st.className = 'status-line err'; PCLog.warn('Уведомления не разрешены: ' + perm); }
      });
    });

    $('#log-copy').addEventListener('click', function () {
      var text = PCLog.asText() || '(логов пока нет)';
      var done = function () { var s = $('#log-status'); s.textContent = 'Скопировано'; s.className = 'status-line ok'; };
      var fail = function () { var s = $('#log-status'); s.textContent = 'Не удалось скопировать — выдели текст вручную'; s.className = 'status-line err'; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fail);
      } else {
        try {
          var ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        } catch (e) { fail(); }
      }
    });

    $('#log-clear').addEventListener('click', function () {
      PCLog.clear();
      renderLogBox();
      $('#log-status').textContent = 'Очищено';
      $('#log-status').className = 'status-line ok';
    });

    $('#d-prev').addEventListener('click', function () { cursor = shift(cursor, -1); renderToday(); });
    $('#d-next').addEventListener('click', function () { if (cursor < today()) { cursor = shift(cursor, 1); renderToday(); } });

    $('#rec-close').addEventListener('click', closeRecorder);
    $('#rec-toggle').addEventListener('click', toggleRecordingUI);
    $('#rec-retake').addEventListener('click', retakeUI);
    $('#rec-send').addEventListener('click', sendRecordingUI);
    $('#rec-gallery').addEventListener('click', openGalleryPicker);
    $('#rec-file').addEventListener('change', function () {
      var f = this.files[0];
      this.value = '';
      handleGalleryFile(f);
    });
    $('#rec-flip').addEventListener('click', function () {
      if (!recSession || recSession.recording) return;
      var next = recSession.facing === 'user' ? 'environment' : 'user';
      PCVideo.closeCamera(recSession.stream);
      recSession.facing = next;
      $('#rec-toggle').disabled = true;
      PCVideo.openCamera(next).then(function (stream) {
        recSession.stream = stream;
        $('#rec-live').srcObject = stream;
        $('#rec-toggle').disabled = false;
      }).catch(function (e) { $('#rec-msg').textContent = 'Нет доступа к камере: ' + e.message; });
    });

    $('#play-close').addEventListener('click', closePlayer);
    $('#play-video').addEventListener('error', function () {
      var v = $('#play-video');
      var code = v.error ? v.error.code : 0;
      $('#play-msg').textContent = 'Не проигралось внутри приложения (код ' + code + ') — попробуй «Открыть ссылкой».';
    });

    $('#cfg-backend').addEventListener('change', function () {
      $('#cfg-cloud').hidden = this.value !== 'cloud';
    });

    $('#cfg-save').addEventListener('click', function () {
      Storage.config.write({
        backend: $('#cfg-backend').value,
        url: $('#cfg-url').value.trim()
      });
      var cfg = Storage.config.read();
      if (cfg.backend !== 'cloud') { setCfgStatus('Данные хранятся на этом устройстве', 'ok'); return; }
      setCfgStatus('Проверяю связь с функцией…');
      Storage.check(cfg)
        .then(function () { setCfgStatus('Функция отвечает, всё в порядке', 'ok'); refreshVideoIndex(); })
        .catch(function (e) { setCfgStatus(e.message, 'err'); });
    });

    $('#cfg-pull').addEventListener('click', function () {
      setCfgStatus('Загружаю…');
      Storage.pull().then(function (remote) {
        if (!remote) { setCfgStatus('В облаке данных ещё нет — выгрузи текущие', 'err'); return; }
        state = normalize(Storage.merge(state, remote));
        Storage.writeLocal(state);
        render();
        setCfgStatus('Загружено из облака', 'ok');
      }).catch(function (e) { setCfgStatus(e.message, 'err'); });
    });

    $('#cfg-push').addEventListener('click', function () {
      setCfgStatus('Выгружаю…');
      state.updatedAt = new Date().toISOString();
      Storage.push(state).then(function (r) {
        setCfgStatus(r.synced ? 'Выгружено через облачную функцию' : 'Облако не настроено — сохранено локально', r.synced ? 'ok' : 'err');
      }).catch(function (e) { setCfgStatus(e.message, 'err'); });
    });

    $('#cfg-anchor').addEventListener('change', function () {
      if (this.value) { state.anchor = this.value; commit(); }
    });

    $('#cfg-export').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pc-sport-' + today() + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });

    $('#cfg-import').addEventListener('click', function () { $('#cfg-file').click(); });
    $('#cfg-file').addEventListener('change', function () {
      var f = this.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          state = normalize(JSON.parse(r.result));
          commit();
          setCfgStatus('Данные загружены из файла', 'ok');
        } catch (e) { setCfgStatus('Файл не читается', 'err'); }
      };
      r.readAsText(f);
      this.value = '';
    });

    $('#cfg-reset').addEventListener('click', function () {
      if (!confirm('Удалить все отметки и вернуть нормы по умолчанию?')) return;
      Storage.reset();
      state = normalize(null);
      commit();
      setCfgStatus('Сброшено', 'ok');
    });

    $('#cfg-sync-video').addEventListener('click', function () {
      var el = $('#cfg-video-status');
      el.className = 'status-line';
      el.textContent = 'Проверяю…';
      Storage.video.sync().then(function (r) {
        el.className = 'status-line ok';
        el.textContent = r.added
          ? 'Досчитал ' + r.added + ' ' + plural(r.added, 'видео', 'видео', 'видео') + ' с Диска'
          : 'Всё совпадает, расхождений нет';
        refreshVideoIndex();
      }).catch(function (e) {
        el.className = 'status-line err';
        el.textContent = e.message;
      });
    });
  }

  /* ============================================================
     Старт
     ============================================================ */
  function boot() {
    state = normalize(Storage.readLocal());
    chatMessages = Storage.chat.readCache();
    cursor = today();
    bind();
    render();
    tick();
    setInterval(tick, 1000);

    /* если день сменился, пока приложение висело в фоне */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (cursor > today()) cursor = today();
      render();
      refreshVideoIndex();
      if (document.getElementById('v-chat').classList.contains('on')) {
        markChatRead();
        pollChat(false).then(renderChat);
      }
      Storage.pull().then(function (remote) {
        if (!remote) return;
        var merged = normalize(Storage.merge(state, remote));
        if (merged !== state) { state = merged; render(); }
      }).catch(function () {});
    });

    Storage.pull().then(function (remote) {
      if (!remote) return;
      state = normalize(Storage.merge(state, remote));
      render();
    }).catch(function () {});
    refreshVideoIndex();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
      });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
