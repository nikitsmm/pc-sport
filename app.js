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
  var REACTIONS = ['👍', '❤️', '😂', '🔥', '💪'];
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
    saveTimer = setTimeout(flushSave, 900);
  }

  /* Сама отправка на Диск — вынесена отдельно от commit(), чтобы её
     можно было запустить и по обычному таймеру, и немедленно, когда
     страница уходит из вида (см. flushOnHide ниже). Без этого второго
     пути возможен реальный сценарий потери отметки: человек поставил
     галочку и в первую секунду (пока ждёт отложенных 900 мс) свернул
     приложение или переключился на другое — таймер в фоне может не
     успеть сработать вовремя на части браузеров, и локально сохранённая
     отметка так и останется локальной, пока кто-то не откроет
     приложение снова или не нажмёт «Выгрузить» вручную. */
  function flushSave() {
    clearTimeout(saveTimer);
    PCLog.info('Сохраняю изменения на Диск…');
    /* Раньше здесь было просто Storage.push(state) — отправка локальной
       копии как есть. Дыра в этом: push ничего не сливает на сервере,
       он просто ПЕРЕЗАПИСЫВАЕТ state.json целиком тем, что прислали
       (см. action_save_state в backend/index.py). Если на сервере уже
       успела появиться чужая более свежая отметка, которую этот телефон
       ещё не подтянул — такая отправка её стирает, причём совершенно
       незаметно для того, кто её отправил (у него на экране всё в
       порядке, это его СОБСТВЕННая копия). Раньше эту проблему чинили
       только на приёме (Storage.merge при pull) — но не на отправке.
       Теперь перед каждой отправкой сначала подтягиваем актуальное с
       сервера и сливаем по записям (дата+участник, см. Storage.merge),
       и отправляем уже объединённый результат — не голую локальную
       копию. */
    Storage.pull().then(function (remote) {
      if (remote) {
        state = normalize(Storage.merge(state, remote));
        Storage.writeLocal(state);
      }
      return Storage.push(state);
    }).then(function (r) {
      if (r && r.synced) {
        PCLog.info('Сохранено на Диск');
        setCfgStatus('Выгружено на Яндекс.Диск', 'ok');
        setSyncDot('ok');
        render();
      } else {
        setSyncDot('local');
      }
    }).catch(function (e) {
      PCLog.error('Не удалось сохранить на Диск: ' + e.message);
      setCfgStatus(e.message, 'err');
      setSyncDot('err');
    });
  }

  /* Если есть несохранённые изменения (точка ещё жёлтая — "pending") и
     страница уходит из вида — досылаем немедленно, не дожидаясь
     истечения обычной задержки. visibilitychange срабатывает надёжнее
     pagehide на iOS Safari при сворачивании (не полном закрытии). */
  function flushOnHide() {
    if ($('#sync-dot').classList.contains('pending')) flushSave();
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

      var repsLine = gone
        ? '<span class="ex">вышел из челленджа</span>'
        : '<b>' + t.reps + '</b> <span class="ex">' + EXNAME[t.ex] + (t.mult > 1 ? ' (' + t.base + '×' + t.mult + ')' : '') + '</span>';

      var body =
        '<div class="head">' +
          '<div class="name">' + p.name + '</div>' +
          '<div class="stat">' + (badges ? '<div class="badges-inline">' + badges + '</div>' : '') +
            '<div class="reps-line">' + repsLine + '</div>' +
          '</div>' +
        '</div>';

      if (!gone) {
        var mine = p.id === myId();
        body += '<div class="status-row">' + STATUSES.map(function (s) {
          return '<button data-p="' + p.id + '" data-s="' + s + '" ' + (mine ? '' : 'disabled') + ' class="' + (st === s ? 'sel s-' + s : '') + '">' +
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
        if (b.dataset.p !== myId()) return;
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
        var inner = v.thumb ? '<img src="' + v.thumb + '" alt="">' : '▶';
        var reps = v.reps ? '<span class="vid-reps">' + v.reps + '</span>' : '';
        var daysLeft = videoIndex.retentionDays ? videoIndex.retentionDays - diffDays(v.date, today()) : null;
        var expiry = (daysLeft !== null && daysLeft <= 1)
          ? '<span class="vid-expiry" title="Удалится по расписанию">' + (daysLeft <= 0 ? 'сегодня' : 'завтра') + '</span>'
          : '';
        var del = v.participantId === myId()
          ? '<button class="vid-del" data-del="' + v.path + '" data-delid="' + v.id + '" data-delname="' + p.name + '" data-deldate="' + shortDate(v.date) + '" title="Удалить видео">✕</button>'
          : '';
        return '<div class="vid-clip"><button class="vid-thumb" data-play="' + v.path + '" data-who="' + p.name + '" data-reps="' + (v.reps || '') + '" title="Смотреть">' +
               inner + reps + expiry + '</button>' + del + '</div>';
      }).join('');
      var addBtn = (!gone && canRecord && p.id === myId())
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
      b.addEventListener('click', function () { openPlayer(b.dataset.play, b.dataset.who, b.dataset.reps); });
    });
    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var msg = 'Удалить видео ' + b.dataset.delname + ' за ' + b.dataset.deldate + '?\nЭто нельзя отменить — файл сотрётся из облака навсегда.';
        if (!confirm(msg)) return;
        var path = b.dataset.del, id = b.dataset.delid;
        b.disabled = true;
        Storage.video.deleteVideo(path, id).then(function () {
          PCLog.info('Видео удалено: ' + id);
          refreshVideoIndex();
        }).catch(function (e) {
          PCLog.error('Не удалось удалить видео: ' + e.message);
          alert('Не удалось удалить: ' + e.message);
          b.disabled = false;
        });
      });
    });
  }

  function refreshVideoIndex() {
    if (!Storage.video.supported()) return Promise.resolve();
    return Storage.video.list().then(function (r) {
      videoIndex = r || { items: [], retentionDays: 0 };
      renderVideos();
      if (videoIndex.retentionDays && $('#cfg-retention-days')) {
        $('#cfg-retention-days').textContent = videoIndex.retentionDays;
      }
      if (r && r.healed) {
        setCfgStatus('Досчитал ' + r.healed + ' ' + plural(r.healed, 'пропущенное видео', 'пропущенных видео', 'пропущенных видео') + ' с Диска', 'ok');
      }
    }).catch(function () { /* тихо: список не критичен для остального интерфейса */ });
  }

  /* Видео, которые не долетели до облака даже после повторов и остались
     в очереди IndexedDB (например, приложение закрыли посреди обрыва
     сети) — при следующем запуске молча пытаемся дозалить сами, без
     необходимости пересъёмки. */
  function resumePendingVideos() {
    if (!Storage.video.supported()) return;
    Storage.video.pending().then(function (items) {
      if (!items.length) return;
      PCLog.info('В очереди ' + items.length + ' ' + plural(items.length, 'недозагруженное видео', 'недозагруженных видео', 'недозагруженных видео') + ' — пробую дозалить');
      items.forEach(function (item) {
        Storage.video.upload(item.participantId, item.date, item.blob, item.ext, null, null, {
          reps: item.reps, thumb: item.thumb, pendingId: item.id
        }).then(function (r) {
          PCLog.info('Дозагрузка из очереди успешна: ' + item.id + ' (confirmed=' + r.confirmed + ')');
          refreshVideoIndex();
        }).catch(function (e) {
          PCLog.warn('Дозагрузка из очереди опять не удалась (' + item.id + '): ' + e.message + ' — останется в очереди, попробуем в следующий раз');
        });
      });
    }).catch(function () {});
  }

  /* ---------- запись ---------- */
  var LS_QUALITY = 'pcsport.videoQuality';
  function getQualityKey() {
    try { return localStorage.getItem(LS_QUALITY) || PCVideo.defaultQuality; }
    catch (e) { return PCVideo.defaultQuality; }
  }
  function setQualityKey(key) {
    try { localStorage.setItem(LS_QUALITY, key); } catch (e) {}
  }

  function renderQualityPicker() {
    var host = $('#rec-quality-pick');
    var cur = getQualityKey();
    host.innerHTML = PCVideo.qualities().map(function (q) {
      return '<button data-q="' + q.key + '" class="' + (q.key === cur ? 'on' : '') + '">' + q.label + '</button>';
    }).join('');
    host.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (recSession && recSession.recording) return; // не меняем на ходу записи
        setQualityKey(b.dataset.q);
        renderQualityPicker();
        PCLog.info('Качество записи: ' + b.dataset.q);
      });
    });
  }

  function openRecorder(participantId) {
    if (participantId !== myId()) return;
    var p = state.participants.filter(function (x) { return x.id === participantId; })[0];
    if (!p) return;
    recSession = { participantId: participantId, date: cursor, facing: 'environment', recording: false, micOn: true };

    $('#rec-who').textContent = p.name + ' · ' + shortDate(cursor);
    $('#rec-msg').textContent = '';
    $('#rec-live').hidden = false;
    $('#rec-preview').hidden = true;
    $('#rec-preview').src = '';
    $('#rec-timer').hidden = true;
    $('#rec-live-controls').hidden = false;
    $('#rec-settings-row').hidden = false;
    $('#rec-controls-preview').hidden = true;
    $('#rec-controls-savefail').hidden = true;
    $('#rec-reps-row').hidden = true;
    $('#rec-reps').value = '';
    setToggleIdle();
    $('#rec-toggle').disabled = true;
    $('#rec-flip').disabled = true;
    $('#rec-gallery').disabled = false;
    $('#rec-mic').classList.add('on');
    $('#rec-mic').classList.remove('off');
    $('#rec-mic').textContent = '🎤 Звук: вкл';
    renderQualityPicker();

    $('#recOverlay').classList.add('on');

    PCVideo.openCamera(recSession.facing, getQualityKey()).then(function (stream) {
      recSession.stream = stream;
      $('#rec-live').srcObject = stream;
      $('#rec-live').classList.toggle('mirror', recSession.facing === 'user');
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
    $('#rec-settings-row').hidden = true;

    recSession.ctrl = PCVideo.startRecording(
      recSession.stream,
      function (secLeft) { $('#rec-timer').textContent = '00:' + String(secLeft).padStart(2, '0'); },
      function (blob, ext) {
        recSession.recording = false;
        $('#rec-live').hidden = true;
        $('#rec-timer').hidden = true;
        setToggleIdle();
        showRecordedPreview(blob, ext);
      },
      getQualityKey(),
      recSession.facing
    );
  }

  /* Общий финиш и для живой записи, и для файла из галереи — дальше
     человек видит один и тот же предпросмотр с кнопками
     «Ещё раз» / «Отправить», не важно, откуда взялся ролик. */
  function showRecordedPreview(blob, ext) {
    recSession.blob = blob;
    recSession.ext = ext;
    recSession.thumb = null;
    $('#rec-live-controls').hidden = true;
    $('#rec-settings-row').hidden = true;
    $('#rec-controls-preview').hidden = false;
    $('#rec-controls-savefail').hidden = true;
    $('#rec-reps-row').hidden = false;
    $('#rec-reps').value = '';
    var preview = $('#rec-preview');
    preview.hidden = false;
    preview.src = URL.createObjectURL(blob);
    var sizeKb = Math.round(blob.size / 1024);
    var sizeStr = sizeKb > 1024 ? (sizeKb / 1024).toFixed(1) + ' МБ' : sizeKb + ' КБ';
    var warn = sizeKb > 15 * 1024 ? ' Файл тяжёлый — загрузка может занять время.' : '';
    $('#rec-msg').textContent = 'Готово, ' + sizeStr + '.' + warn;
    grabThumbnail(preview);
  }

  /* Мини-превью для списка «Видео дня» — кадр из самого ролика,
     ужатый до маленькой JPEG-картинки, хранится прямо в записи индекса
     (десятки КБ, отдельная загрузка в S3 не нужна). Best-effort: если
     на каком-то устройстве не получится (редко, но бывает) — просто
     останется без миниатюры, значок «▶» как раньше. */
  function grabThumbnail(videoEl) {
    var done = false;
    function capture() {
      if (done) return;
      try {
        var w = 160, h = Math.round(160 * (videoEl.videoHeight / videoEl.videoWidth || 1.33));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(videoEl, 0, 0, w, h);
        recSession.thumb = canvas.toDataURL('image/jpeg', 0.55);
        done = true;
      } catch (e) { PCLog.warn('Миниатюра не собралась: ' + e.message); }
    }
    if (videoEl.readyState >= 2) capture();
    else videoEl.addEventListener('loadeddata', capture, { once: true });
    setTimeout(capture, 700); // запасной путь, если loadeddata почему-то не пришло
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
    $('#rec-msg').textContent = 'Сжимаю видео из галереи (' + (originalKb / 1024).toFixed(1) + ' МБ) — займёт примерно столько же времени, сколько длится сам ролик, это не зависание.';

    PCVideo.compressFile(
      file,
      function (secLeft) { $('#rec-timer').textContent = 'ещё ~' + secLeft + ' с'; },
      function (blob, ext) {
        $('#rec-timer').hidden = true;
        showRecordedPreview(blob, ext);
        var newKb = Math.round(blob.size / 1024);
        var ratio = blob.size / file.size;
        var sizeMsg = ' Было ' + (originalKb > 1024 ? (originalKb / 1024).toFixed(1) + ' МБ' : originalKb + ' КБ') +
          ' → стало ' + (newKb > 1024 ? (newKb / 1024).toFixed(1) + ' МБ' : newKb + ' КБ') + '.';
        /* Сжатие технически "прошло" (не пустой файл, не ошибка) — но
           если размер почти не изменился, значит браузер на этом
           устройстве не уважает заданный битрейт для canvas-потока так
           же строго, как для потока с камеры (для живой записи это
           проверено, для сжатия готового файла — другой путь, гарантии
           той же нет). Честно предупреждаем, а не выдаём за успех. */
        if (ratio > 0.6) {
          sizeMsg += ' Сжатие почти не сработало на этом устройстве — файл всё равно тяжёлый, загрузка может занять время.';
          PCLog.warn('Сжатие галереи почти не уменьшило файл: было ' + originalKb + ' КБ, стало ' + newKb + ' КБ (' + Math.round(ratio * 100) + '%)');
        }
        $('#rec-msg').textContent += sizeMsg;
      },
      function () {
        /* Сжатие не задалось — не теряем видео, отправляем как есть.
           Единственная жертва — медленнее загрузится, зато гарантированно
           не пустой файл. */
        $('#rec-timer').hidden = true;
        showRecordedPreview(file, extForMime(file.type));
        $('#rec-msg').textContent = 'Не получилось сжать — отправлю как есть, может занять больше времени.';
      },
      getQualityKey()
    );
  }

  function retakeUI() {
    var preview = $('#rec-preview');
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.src = '';
    preview.hidden = true;
    $('#rec-live').hidden = false;
    $('#rec-controls-preview').hidden = true;
    $('#rec-controls-savefail').hidden = true;
    $('#rec-reps-row').hidden = true;
    $('#rec-reps').value = '';
    $('#rec-live-controls').hidden = false;
    $('#rec-settings-row').hidden = false;
    $('#rec-flip').disabled = false;
    $('#rec-gallery').disabled = false;
    $('#rec-msg').textContent = '';
    if (recSession) recSession.thumb = null;
  }

  function sendRecordingUI() {
    if (!recSession || !recSession.blob) return;
    var s = recSession;
    var who = participantName(s.participantId);
    var repsVal = parseInt($('#rec-reps').value, 10);
    var meta = { reps: (repsVal > 0 ? repsVal : null), thumb: s.thumb || null };

    /* Норма уже известна приложению (та же task(), что считает число на
       карточке «Сегодня», с учётом отработки после форс-мажора) —
       раз человек всё равно вводит количество повторений к видео,
       грех не сравнить и не предложить сразу закрыть день, вместо
       того чтобы потом отдельно идти отмечать галочку руками. */
    if (meta.reps) {
      var p = state.participants.filter(function (x) { return x.id === s.participantId; })[0];
      if (p && statusOf(p, s.date) !== 'done') {
        var need = task(p, s.date).reps;
        if (meta.reps >= need) {
          if (confirm('Норма выполнена (' + meta.reps + ' из ' + need + ') — закрыть день как «Норма»?')) {
            setStatus(p, s.date, 'done');
            PCLog.info('Норма закрыта автоматически по видео: ' + who + ', ' + shortDate(s.date) + ' (' + meta.reps + '/' + need + ')');
          }
        }
      }
    }

    $('#rec-controls-preview').hidden = true;
    $('#rec-reps-row').hidden = true;
    $('#rec-controls-savefail').hidden = true;
    $('#rec-msg').textContent = 'Отправляю… 0%';

    PCLog.info('Видео: начинаю загрузку (' + who + ', ' + shortDate(s.date) + ', ' + Math.round(s.blob.size / 1024) + ' КБ' + (meta.reps ? ', ' + meta.reps + ' повт.' : '') + ')');

    var slowHint = setTimeout(function () {
      $('#rec-msg').textContent += ' (сеть иногда даёт паузу — это не всегда зависание, идёт повтор)';
    }, 20000);

    Storage.video.upload(
      s.participantId, s.date, s.blob, s.ext,
      function (frac) { $('#rec-msg').textContent = 'Отправляю… ' + Math.round(frac * 100) + '%'; },
      function (phase) { $('#rec-msg').textContent = phase; },
      meta
    ).then(function (r) {
      clearTimeout(slowHint);
      $('#rec-msg').textContent = r.confirmed
        ? 'Отправлено'
        : 'Файл на Диске, но подтверждение задержалось — появится в списке само';
      PCLog.info('Видео: загружено (' + who + ', confirmed=' + r.confirmed + ')');

      setTimeout(function () {
        closeRecorder();
        refreshVideoIndex();
      }, r.confirmed ? 500 : 1500);
    }).catch(function (e) {
      clearTimeout(slowHint);
      $('#rec-msg').textContent = 'Не отправилось после нескольких попыток: ' + e.message + '. Ролик никуда не делся — можно сохранить в галерею или попробовать ещё раз.';
      $('#rec-controls-savefail').hidden = false;
      PCLog.error('Видео: загрузка не удалась (' + who + '): ' + e.message);
      chatAnnounce(s.participantId, '⚠️ Не получилось загрузить видео: ' + e.message);
    });
  }

  /* Ролик не ушёл в облако даже после повторов — не теряем его.
     На iOS/Android navigator.share с файлом обычно предлагает «Сохранить
     в Фото»; если share недоступен — обычная ссылка на скачивание. */
  function saveBlobToGallery(blob, filenameBase) {
    var ext = recSession && recSession.ext || 'mp4';
    var file = new File([blob], filenameBase + '.' + ext, { type: blob.type || ('video/' + ext) });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Видео ПЦ Спорт' }).catch(function () {});
      return;
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ---------- просмотр ---------- */
  var SPEEDS = [0.5, 1, 1.5, 2];

  function renderSpeedPicker() {
    var host = $('#play-speed');
    var v = $('#play-video');
    host.innerHTML = SPEEDS.map(function (s) {
      return '<button data-speed="' + s + '" class="' + (v.playbackRate === s ? 'on' : '') + '">' + (s === 1 ? '1×' : s + '×') + '</button>';
    }).join('');
    host.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        v.playbackRate = parseFloat(b.dataset.speed);
        host.querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    });
  }

  function openPlayer(path, who, reps) {
    $('#play-who').textContent = (who || '—') + (reps ? ' · ' + reps + ' повт.' : '');
    $('#play-video').src = '';
    $('#play-video').playbackRate = 1;
    $('#play-msg').textContent = 'Загружаю…';
    $('#play-fallback').href = '#';
    renderSpeedPicker();
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
    v.playbackRate = 1;
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

  /* «Кто я» — общая для всего приложения идентичность на этом
     телефоне: отмечать дни и грузить видео можно только за себя. */
  function myId() { return Storage.identity.read(); }

  /* Закрепление идентичности. Обычным способом её потом не поменять —
     только явный сброс в настройках, который сам себя объявляет в чат.
     Здесь же — разница между первым выбором на этом телефоне и
     повторным (после сброса): второе звучит тревожнее, это и есть цель. */
  function commitIdentity(id) {
    var p = state.participants.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    var wasEverSet = Storage.identity.everSet();

    Storage.identity.write(id);
    Storage.identity.markEverSet();
    PCLog.info('Идентичность закреплена: ' + id + (wasEverSet ? ' (повторный выбор после сброса)' : ' (первый выбор)'));

    $('#whoOverlay').classList.remove('on');
    renderWhoBtn();
    render();

    var text = wasEverSet
      ? '⚠️ На этом телефоне идентичность сбрасывали и выбрали заново: ' + p.name + '. Если это не ты — напиши в чат.'
      : '🔒 ' + p.name + ' закрепил(а) за собой это устройство.';
    chatAnnounce(id, text);
  }

  /* Модалка «Кто я» — всегда обязательная (без кнопки закрытия): пока
     идентичность не выбрана, ничего в приложении не работает. */
  function openIdentityGate() {
    renderWhoPicker('#who-pick', myId(), commitIdentity);
    $('#whoOverlay').classList.add('on');
  }

  function renderWhoBtn() {
    var id = myId();
    var btn = $('#who-btn');
    var p = state.participants.filter(function (x) { return x.id === id; })[0];
    btn.textContent = p ? p.name : 'Кто я?';
    btn.classList.toggle('unset', !p);
  }

  var reactionPickerFor = null; // id сообщения, для которого сейчас раскрыт выбор реакции

  /* Цвет и инициал участника — детерминированные, как MEMBER_PALETTE в
     Herald Chat, только палитра фиксированная под четырёх известных
     участников (тут не нужен хэш по id — их и так всего четыре). */
  var PARTICIPANT_COLOR = { kolya: '#64B5F6', vanya: '#81C784', artur: '#FFB74D', anton: '#BA68C8' };
  function participantColor(id) { return PARTICIPANT_COLOR[id] || '#9aa0a8'; }
  function participantInitial(id) {
    var name = participantName(id);
    return name ? name.trim().charAt(0).toUpperCase() : '?';
  }

  /* Группировка подряд идущих сообщений одного автора (как в телеге):
     сообщения одного отправителя без больших пауз между собой визуально
     объединяются в одну "пачку" — имя и аватар показываются только у
     первого/последнего сообщения пачки, остальные идут вплотную. */
  var GROUP_GAP_MS = 5 * 60 * 1000;
  function sameGroup(a, b) {
    return a && b && a.participantId === b.participantId &&
      Math.abs(new Date(b.at) - new Date(a.at)) < GROUP_GAP_MS;
  }

  function renderReactions(m) {
    var mine = myId();
    var reactions = m.reactions || {};

    if (reactionPickerFor === m.id) {
      return '<div class="msg-reactions">' + REACTIONS.map(function (e) {
        return '<button class="react-choice" data-mid="' + m.id + '" data-emoji="' + e + '">' + e + '</button>';
      }).join('') + '</div>';
    }

    var pills = REACTIONS.map(function (e) {
      var who = reactions[e] || [];
      var isMine = who.indexOf(mine) !== -1;
      if (!who.length) return '';
      return '<button class="react-pill' + (isMine ? ' mine' : '') + '" data-mid="' + m.id + '" data-emoji="' + e + '">' +
             e + ' ' + who.length + '</button>';
    }).join('');
    return '<div class="msg-reactions">' + pills + '<button class="react-add" data-mid="' + m.id + '">😊+</button></div>';
  }

  function renderReplyQuote(m) {
    if (!m.replyTo) return '';
    var orig = chatMessages.filter(function (x) { return x.id === m.replyTo; })[0];
    if (!orig) return '<div class="reply-quote" data-scrollto="' + m.replyTo + '"><b>Ответ на сообщение</b></div>';
    var preview = orig.type === 'video' ? '🎥 видео' : (orig.text || '').slice(0, 80);
    return '<div class="reply-quote" data-scrollto="' + orig.id + '"><b>' + esc(participantName(orig.participantId)) + '</b><span>' + esc(preview) + '</span></div>';
  }

  function renderMessageBody(m, time) {
    if (m.type === 'video') {
      var thumb = m.videoThumb ? '<img src="' + m.videoThumb + '" alt="">' : '<div class="chat-vid-noimg">▶</div>';
      var reps = m.videoReps ? '<span class="chat-vid-reps">' + m.videoReps + ' повт.</span>' : '';
      var caption = m.text ? '<div class="bubble-text">' + esc(m.text) + '<span class="msg-time-inline">' + time + '</span></div>' : '<div class="msg-time-inline" style="float:none;display:block;text-align:right;margin-top:3px;">' + time + '</div>';
      return '<button class="chat-vid-card" data-play="' + m.videoPath + '" data-who="' + esc(participantName(m.participantId)) + '" data-reps="' + (m.videoReps || '') + '">' +
             thumb + '<span class="chat-vid-play">▶</span>' + reps + '</button>' + caption;
    }
    return '<div class="bubble-text">' + esc(m.text) + '<span class="msg-time-inline">' + time + (m.pending ? ' · отправка…' : '') + '</span></div>';
  }

  function renderChat() {
    var myId = Storage.identity.read();
    var known = state.participants.some(function (p) { return p.id === myId; });

    $('#chat-noauth').hidden = known;
    $('#chat-wrap').hidden = !known;

    if (!known) {
      renderWhoPicker('#chat-who-pick', myId, commitIdentity);
      return;
    }

    var log = $('#chat-log');
    /* Тот же нюанс, что и в scrollChatToBottom(): у #chat-log нет
       своего overflow, скроллится вся страница (окно), не div. */
    var wasAtBottom = (document.body.scrollHeight - window.scrollY - window.innerHeight) < 80;

    var divider = computeUnreadDivider(myId);

    var lastDay = '';
    log.innerHTML = chatMessages.map(function (m, i) {
      var day = m.at ? m.at.slice(0, 10) : '';
      var sep = '';
      if (day && day !== lastDay) { sep = '<div class="chat-day">' + shortDate(day) + '</div>'; lastDay = day; }
      if (divider && m.id === divider.beforeId) {
        sep += '<div class="chat-unread-divider">▲ ' + divider.count + ' ' + plural(divider.count, 'новое', 'новых', 'новых') + '</div>';
      }

      var mine = m.participantId === myId;
      var isGroupStart = i === 0 || !sameGroup(chatMessages[i - 1], m);
      var isGroupEnd = i === chatMessages.length - 1 || !sameGroup(m, chatMessages[i + 1]);
      var time = m.at ? m.at.slice(11, 16) : '';

      var avatarHtml = mine ? '' : (isGroupEnd
        ? '<div class="msg-avatar" style="background:' + participantColor(m.participantId) + '">' + participantInitial(m.participantId) + '</div>'
        : '<div class="avatar-spacer"></div>');
      var senderHtml = (isGroupStart && !mine)
        ? '<div class="msg-sender-inline" style="color:' + participantColor(m.participantId) + '">' + esc(participantName(m.participantId)) + '</div>'
        : '';
      var replyBtn = m.pending ? '' : '<button class="reply-btn" data-mid="' + m.id + '" title="Ответить">↩</button>';

      var rowCls = 'msg-row' + (mine ? ' mine' : '') + (isGroupStart ? ' group-start' : '');
      var bubbleCls = 'bubble' + (mine ? ' out' : ' in') + (m.pending ? ' pending' : '');

      return sep +
        '<div class="' + rowCls + '" id="msg-' + m.id + '">' + avatarHtml +
          '<div class="msg-col">' +
            '<div class="' + bubbleCls + '">' + replyBtn + senderHtml + renderReplyQuote(m) + renderMessageBody(m, time) + '</div>' +
            (m.pending ? '' : renderReactions(m)) +
          '</div>' +
        '</div>';
    }).join('');

    log.querySelectorAll('.reply-quote[data-scrollto]').forEach(function (b) {
      b.addEventListener('click', function () {
        var target = document.getElementById('msg-' + b.dataset.scrollto);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash');
        setTimeout(function () { target.classList.remove('flash'); }, 900);
      });
    });

    log.querySelectorAll('.reply-btn').forEach(function (b) {
      b.addEventListener('click', function () { startReply(b.dataset.mid); });
    });

    log.querySelectorAll('[data-play]').forEach(function (b) {
      b.addEventListener('click', function () { openPlayer(b.dataset.play, b.dataset.who, b.dataset.reps); });
    });
    log.querySelectorAll('.react-pill, .react-choice').forEach(function (b) {
      b.addEventListener('click', function () {
        reactionPickerFor = null;
        Storage.chat.react(myId, b.dataset.mid, b.dataset.emoji).then(function (updated) {
          var m = chatMessages.filter(function (x) { return x.id === b.dataset.mid; })[0];
          if (m) m.reactions = updated.reactions;
          renderChat();
        }).catch(function (e) { PCLog.warn('Реакция не отправилась: ' + e.message); });
      });
    });
    log.querySelectorAll('.react-add').forEach(function (b) {
      b.addEventListener('click', function () {
        reactionPickerFor = (reactionPickerFor === b.dataset.mid) ? null : b.dataset.mid;
        renderChat();
      });
    });

    if (wasAtBottom) window.scrollTo(0, document.body.scrollHeight);
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
    var changed = false;
    items.forEach(function (m) {
      if (!byId[m.id]) {
        chatMessages.push(m);
        byId[m.id] = m;
        changed = true;
      } else if (JSON.stringify(byId[m.id].reactions || {}) !== JSON.stringify(m.reactions || {})) {
        /* Сообщение уже известно — но, например, кто-то другой поставил
           реакцию на него. Обновляем на месте, не просто добавляем новые. */
        byId[m.id].reactions = m.reactions;
        changed = true;
      }
    });
    if (changed) {
      chatMessages.sort(function (a, b) { return (a.at || '') < (b.at || '') ? -1 : 1; });
      Storage.chat.writeCache(chatMessages);
    }
    return changed;
  }

  var chatPollCount = 0;

  function pollChat(isInitial) {
    var cfg = Storage.config.read();
    if (cfg.backend !== 'cloud' || !cfg.url) return Promise.resolve();
    /* since-опрос экономит трафик, но принципиально не видит изменений
       на УЖЕ известных сообщениях (например, реакцию, которую кто-то
       другой поставил на старое сообщение) — сервер отдаёт по since
       только то, что добавлено ПОСЛЕ. Раз в несколько тиков делаем
       полный опрос без since, чтобы такие изменения всё-таки долетали,
       не только у себя же после собственной реакции. */
    chatPollCount++;
    var fullPoll = isInitial || (chatPollCount % 4 === 0);
    var since = chatMessages.length ? chatMessages[chatMessages.length - 1].id : null;
    return Storage.chat.fetch(fullPoll ? null : since).then(function (r) {
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
    chatPollCount = 0;
    pollChat(true);
    chatPollTimer = setInterval(function () { pollChat(false); }, 8000);
  }
  function stopChatPolling() {
    clearInterval(chatPollTimer);
    chatPollTimer = null;
  }

  /* ============================================================
     Centrifugo — реальное время вместо ожидания опроса раз в 8 секунд.
     Опрос (startChatPolling выше) остаётся включённым ОДНОВРЕМЕННО —
     это осознанно: на первом заходе безопаснее иметь работающую
     подстраховку, чем полагаться только на новый механизм. Если
     Centrifugo недоступен или ещё не настроен на бэкенде (переменные
     окружения не выставлены) — просто тихо не подключаемся, чат как и
     раньше работает через опрос, ничего не ломается. */
  var centrifugeClient = null;

  function connectRealtime() {
    if (centrifugeClient) return; // уже подключены
    if (typeof Centrifuge === 'undefined') return; // библиотека не подгрузилась (например, офлайн)
    var myIdVal = myId();
    if (!myIdVal) return;

    Storage.chat.getRealtimeToken(myIdVal).then(function (r) {
      if (!r || !r.token || !r.url || !r.channel) return;
      var wsUrl = r.url.replace(/^http/, 'ws') + '/connection/websocket';
      var client = new Centrifuge(wsUrl, { token: r.token });

      client.on('connected', function () { PCLog.info('Centrifugo: подключено, реальное время включено'); });
      client.on('disconnected', function (ctx) { PCLog.warn('Centrifugo: отключено (' + (ctx && ctx.reason) + ') — держимся на опросе'); });
      client.on('error', function (ctx) { PCLog.warn('Centrifugo: ошибка соединения — ' + JSON.stringify(ctx)); });

      var sub = client.newSubscription(r.channel);
      sub.on('publication', function (ctx) {
        var data = ctx.data;
        if (!data || !data.message) return;
        /* chatMerge сама разбирается, новое это сообщение или
           обновление реакций на уже известном — один и тот же путь
           для обоих типов событий с бэкенда. */
        var changed = chatMerge([data.message]);
        if (!changed) return;
        var onChatTab = document.getElementById('v-chat').classList.contains('on');
        if (onChatTab && !document.hidden) {
          markChatRead();
          renderChat();
        } else if (data.message.participantId !== myIdVal) {
          bumpChatUnread(1);
          notifyNewMessages([data.message]);
        }
      });
      sub.subscribe();
      client.connect();
      centrifugeClient = client;
    }).catch(function (e) {
      PCLog.warn('Centrifugo недоступен, работаем через обычный опрос: ' + e.message);
    });
  }

  function disconnectRealtime() {
    if (centrifugeClient) {
      centrifugeClient.disconnect();
      centrifugeClient = null;
    }
  }

  function bumpChatUnread(n) {
    var dot = $('#chat-dot');
    if (!dot) return;
    var count = (parseInt(dot.textContent, 10) || 0) + n;
    dot.textContent = String(count);
    dot.hidden = false;
    setAppBadge(count);
  }

  var unreadSnapshot = null; // { beforeId, count } — фиксируется на момент открытия вкладки чата

  function prepareUnreadSnapshot() {
    var lastRead = null;
    try { lastRead = localStorage.getItem(LS_LAST_READ) || null; } catch (e) {}
    var myIdVal = Storage.identity.read();
    if (!chatMessages.length) { unreadSnapshot = null; return; }

    var startIdx = 0;
    if (lastRead) {
      var idx = chatMessages.findIndex(function (m) { return m.id === lastRead; });
      startIdx = (idx === -1) ? chatMessages.length : idx + 1;
    }
    var unread = chatMessages.slice(startIdx).filter(function (m) { return m.participantId !== myIdVal; });
    unreadSnapshot = (unread.length && startIdx < chatMessages.length)
      ? { beforeId: chatMessages[startIdx].id, count: unread.length }
      : null;
  }

  /* Возвращает уже посчитанный снимок — специально не пересчитывает на
     лету при каждом рендере, иначе делитель "N новых" исчезал бы сразу
     же после markChatRead(), не успев показаться человеку. */
  function computeUnreadDivider() { return unreadSnapshot; }

  function setAppBadge(n) {
    if (!('setAppBadge' in navigator)) return;
    if (n > 0) navigator.setAppBadge(n).catch(function () {});
    else if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(function () {});
  }

  function markChatRead() {
    var dot = $('#chat-dot');
    if (dot) { dot.hidden = true; dot.textContent = ''; }
    setAppBadge(0);
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

  var replyingTo = null; // сообщение, на которое сейчас готовится ответ

  function sendChatMessage(text) {
    var myId = Storage.identity.read();
    text = (text || '').trim();
    if (!text || !myId) return Promise.resolve();
    var tempId = 'tmp-' + Date.now();
    var replyToId = replyingTo ? replyingTo.id : null;
    var optimistic = { id: tempId, participantId: myId, text: text, at: new Date().toISOString(), pending: true, replyTo: replyToId };
    chatMessages.push(optimistic);
    clearReply();
    renderChat();
    window.scrollTo(0, document.body.scrollHeight);
    return Storage.chat.send(myId, text, replyToId, tempId).then(function (msg) {
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

  function startReply(messageId) {
    var m = chatMessages.filter(function (x) { return x.id === messageId; })[0];
    if (!m) return;
    replyingTo = m;
    renderReplyBar();
    var input = $('#chat-text');
    if (input) input.focus();
  }

  function clearReply() {
    replyingTo = null;
    renderReplyBar();
  }

  function renderReplyBar() {
    var bar = $('#chat-reply-bar');
    if (!bar) return;
    if (!replyingTo) { bar.hidden = true; bar.innerHTML = ''; return; }
    var name = participantName(replyingTo.participantId);
    var preview = replyingTo.type === 'video' ? '🎥 видео' : (replyingTo.text || '').slice(0, 80);
    bar.hidden = false;
    bar.innerHTML = '<div class="reply-bar-txt"><b>' + esc(name) + '</b><br>' + esc(preview) + '</div><button id="chat-reply-cancel">✕</button>';
    $('#chat-reply-cancel').addEventListener('click', clearReply);
    repositionChatBars();
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
        if (!activeOn(p, d)) return '<td><span class="cell-none">·</span></td>';
        var st = statusOf(p, d);
        return '<td><span class="cell-' + (st || 'none') + '">' + (st ? GLYPH[st] : '·') + '</span></td>';
      }).join('');
      rows.push('<tr class="' + (isWeekend(d) ? 'we' : '') + '"><td class="d">' + shortDate(d) + '</td>' + cells + '</tr>');
    }

    var table = $('#log-table');
    table.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';
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

  function renderCfgWho() {
    var host = $('#cfg-who-pick');
    var id = myId();
    var p = state.participants.filter(function (x) { return x.id === id; })[0];

    if (!p) { renderWhoPicker('#cfg-who-pick', id, commitIdentity); return; }

    host.innerHTML =
      '<div class="who-locked-name">' + p.name + '</div>' +
      '<button class="btn danger" id="cfg-who-reset" style="margin-top:12px">Сбросить идентичность</button>';
    $('#cfg-who-reset').addEventListener('click', function () {
      if (!confirm('Сбросить идентичность? В общий чат уйдёт сообщение об этом, и придётся выбирать заново.')) return;
      Storage.identity.reset();
      PCLog.warn('Идентичность сброшена вручную (' + p.name + ')');
      renderWhoBtn();
      renderCfgWho();
      openIdentityGate();
    });
  }

  /* Коротко, по 2-4 пункта на версию, только заметное человеку —
     полная история со всеми техническими деталями в README.md проекта.
     Обновлять при каждом бампе версии в шапке. */
  var CHANGELOG = [
    { v: 'v43', items: [
      'Чат: сообщения и реакции теперь долетают мгновенно (своя виртуалка с Centrifugo), не ждут опроса раз в 8 секунд',
      'Опрос оставлен как подстраховка на фоне — если реальное время недоступно, чат тихо продолжает работать как раньше'
    ] },
    { v: 'v42', items: [
      'Критично: отметки нормы иногда пропадали при почти одновременной отправке с разных телефонов — починено',
      'То же самое чинит и кнопка «Обновить»'
    ] },
    { v: 'v41', items: [
      'Чат: поле ввода сообщения больше не убегает при открытии клавиатуры',
      'Настройки: компактнее — карточки участников и выбор идентичности занимают меньше места',
      'Кнопка «Обновить» теперь честно показывает результат и не крутится дольше 15 секунд',
      'Уведомления перенесены в самый верх настроек'
    ] },
    { v: 'v40', items: [
      'Починены дубли сообщений в чате (уходили по 3-4 раза при сбое сети)',
      'У своих сообщений в чате убран лишний аватар',
      'Тёмный фон вкладки чата теперь доходит до самого низа экрана'
    ] },
    { v: 'v39', items: [
      'Оформление чата переделано в стиле Telegram — пузыри, группировка, реакции, ответы'
    ] }
  ];

  function renderChangelog() {
    var host = $('#cfg-changelog');
    if (!host) return;
    host.innerHTML = CHANGELOG.map(function (v) {
      return '<div class="cl-version"><b>' + v.v + '</b><ul>' +
        v.items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') +
        '</ul></div>';
    }).join('');
  }

  function renderCfg() {
    renderLogBox();
    renderCfgWho();
    renderChangelog();
    var cfg = Storage.config.read();
    $('#cfg-backend').value = cfg.backend;
    $('#cfg-url').value = cfg.url || '';
    $('#cfg-cloud').hidden = cfg.backend !== 'cloud';
    $('#cfg-anchor').value = state.anchor;
    $('#cfg-version').textContent = 'Обновлено: ' + (state.updatedAt ? new Date(state.updatedAt).toLocaleString('ru-RU') : 'ещё не сохранялось');

    $('#cfg-people').innerHTML = state.participants.map(function (p) {
      var fields = p.mode === 'alt'
        ? '<div class="ppl-field"><span>Подтяг.</span><input type="number" min="1" data-f="pullups" data-p="' + p.id + '" value="' + p.pullups + '"></div>' +
          '<div class="ppl-field"><span>Отжим.</span><input type="number" min="1" data-f="pushups" data-p="' + p.id + '" value="' + p.pushups + '"></div>'
        : '<div class="ppl-field"><span>Отжим./день</span><input type="number" min="1" data-f="reps" data-p="' + p.id + '" value="' + p.reps + '"></div>';
      return '<div class="ppl-card">' +
             '<div class="ppl-name">' + p.name + '</div>' +
             '<div class="ppl-row">' + fields +
               '<div class="ppl-field"><span>Вышел</span><input type="date" data-f="leftAt" data-p="' + p.id + '" value="' + (p.leftAt || '') + '"></div>' +
             '</div></div>';
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
    renderWhoBtn();
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
      prepareUnreadSnapshot();
      markChatRead();
      renderChat();
      startChatPolling();
      connectRealtime();
      scrollChatToBottom();
      repositionChatBars();
    } else {
      stopChatPolling();
      disconnectRealtime();
      unreadSnapshot = null; // при следующем открытии посчитается заново
    }
  }

  /* Отдельная функция, а не часть renderChat(): нужно гарантированно
     долистать в самый низ именно в момент ОТКРЫТИЯ вкладки, а не
     полагаться на эвристику "прокрутка уже была внизу" — при первом
     показе вкладки контейнер только что стал видимым, и его текущие
     scrollHeight/scrollTop ещё не отражают реальную раскладку. Двойной
     rAF — layout успевает посчитаться перед тем, как прокручиваем. */
  function scrollChatToBottom() {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        /* У #chat-log нет своего overflow — как и везде в приложении,
           скроллится вся страница целиком (body), не отдельный div.
           Раньше здесь стояло log.scrollTop = log.scrollHeight — это
           no-op на нескроллящемся элементе, поэтому прокрутка вниз не
           срабатывала вообще. */
        window.scrollTo(0, document.body.scrollHeight);
      });
    });
  }

  /* Держит композер (и панель ответа над ним) прижатыми к клавиатуре
     на iOS — position:fixed сам по себе этого не гарантирует, когда
     клавиатура открыта, нужно вручную пересчитывать отступ снизу по
     window.visualViewport (см. пояснение в styles.css у .chat-input).
     Без visualViewport (старые браузеры) — просто ничего не делаем,
     остаётся дефолтный CSS-отступ под нижнюю панель. */
  var NAV_CLEARANCE_PX = 70; // должно совпадать с базовым bottom в CSS у .chat-input

  function repositionChatBars() {
    var composer = document.querySelector('.chat-input');
    if (!composer) return;
    var replyBar = document.getElementById('chat-reply-bar');
    var kb = 0;
    if (window.visualViewport) {
      kb = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
    }
    var safeB = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-b')) || 0;
    var bottom = kb > 40 ? (kb + 4) : (NAV_CLEARANCE_PX + safeB);
    composer.style.bottom = bottom + 'px';
    if (replyBar && !replyBar.hidden) {
      replyBar.style.bottom = (bottom + composer.getBoundingClientRect().height) + 'px';
    }
    if (kb > 40 && document.getElementById('v-chat').classList.contains('on')) {
      window.scrollTo(0, document.body.scrollHeight);
    }
  }

  function initChatKeyboardOffset() {
    if (!window.visualViewport) return;
    window.visualViewport.addEventListener('resize', repositionChatBars);
    window.visualViewport.addEventListener('scroll', repositionChatBars);
    repositionChatBars();
  }

  function bind() {
    document.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.view); });
    });

    $('#who-btn').addEventListener('click', function () {
      var id = myId();
      if (id) {
        alert('Идентичность закреплена: ' + participantName(id) + '.\nСбросить можно в Настройках — это уйдёт сообщением в общий чат.');
        return;
      }
      openIdentityGate();
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
      if (!myId()) { st.textContent = 'Сначала выбери, кто ты (см. выше)'; st.className = 'status-line err'; return; }

      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') {
          st.textContent = 'Не разрешено в браузере';
          st.className = 'status-line err';
          PCLog.warn('Уведомления не разрешены: ' + perm);
          return;
        }
        if (!Storage.push.supported()) {
          st.textContent = 'Разрешение получено, но push не поддерживается — на iPhone работает только для версии, добавленной на «Экран Домой»';
          st.className = 'status-line err';
          return;
        }
        st.textContent = 'Оформляю подписку…';
        Storage.push.subscribe(myId()).then(function () {
          st.textContent = 'Включено — теперь прилетит, даже если приложение полностью закрыто';
          st.className = 'status-line ok';
          PCLog.info('Push-подписка оформлена для ' + myId());
        }).catch(function (e) {
          st.textContent = 'Не получилось подписаться: ' + e.message;
          st.className = 'status-line err';
          PCLog.error('Push-подписка не удалась: ' + e.message);
        });
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
    $('#rec-save-gallery').addEventListener('click', function () {
      if (!recSession || !recSession.blob) return;
      saveBlobToGallery(recSession.blob, 'pc-sport-' + recSession.participantId + '-' + recSession.date);
      PCLog.info('Видео сохранено в галерею вручную (после сбоя отправки)');
    });
    $('#rec-save-early').addEventListener('click', function () {
      if (!recSession || !recSession.blob) return;
      saveBlobToGallery(recSession.blob, 'pc-sport-' + recSession.participantId + '-' + recSession.date);
      PCLog.info('Видео сохранено в галерею вручную (до отправки, на всякий случай)');
    });
    $('#rec-retry').addEventListener('click', sendRecordingUI);
    $('#rec-gallery').addEventListener('click', openGalleryPicker);
    $('#rec-file').addEventListener('change', function () {
      var f = this.files[0];
      this.value = '';
      handleGalleryFile(f);
    });
    $('#rec-flip').addEventListener('click', function () {
      if (!recSession || recSession.recording) return;
      var next = recSession.facing === 'user' ? 'environment' : 'user';
      var micWas = recSession.micOn;
      PCVideo.closeCamera(recSession.stream);
      recSession.facing = next;
      $('#rec-toggle').disabled = true;
      PCVideo.openCamera(next, getQualityKey()).then(function (stream) {
        recSession.stream = stream;
        PCVideo.setMic(stream, micWas);
        $('#rec-live').srcObject = stream;
        $('#rec-live').classList.toggle('mirror', next === 'user');
        $('#rec-toggle').disabled = false;
      }).catch(function (e) { $('#rec-msg').textContent = 'Нет доступа к камере: ' + e.message; });
    });

    $('#rec-mic').addEventListener('click', function () {
      if (!recSession || !recSession.stream) return;
      recSession.micOn = !recSession.micOn;
      PCVideo.setMic(recSession.stream, recSession.micOn);
      var btn = $('#rec-mic');
      btn.classList.toggle('on', recSession.micOn);
      btn.classList.toggle('off', !recSession.micOn);
      btn.textContent = recSession.micOn ? '🎤 Звук: вкл' : '🔇 Звук: выкл';
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

    $('#ql-refresh').addEventListener('click', function () {
      var btn = $('#ql-refresh');
      var label = $('#ql-refresh-label');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add('spinning');
      label.textContent = 'Обновляю…';
      setSyncDot('pending');
      PCLog.info('Обновление вручную: выгружаю, затем подтягиваю свежее');

      /* fetch() сам по себе никогда не отваливается по таймауту — если
         сеть просто зависнет, кнопка крутилась бы бесконечно, и вообще
         непонятно, сработало или нет. Явный потолок в 15 секунд решает
         оба: и не виснет вечно, и результат всегда виден у самой кнопки,
         а не в невидимом на этой вкладке статусе настроек. */
      var timeout = new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('Не отвечает больше 15 секунд')); }, 15000);
      });

      /* Порядок важен: раньше тут сначала отправлялось локальное (push),
         потом подтягивалось свежее (pull) — а push ничего не сливает на
         сервере, он перезаписывает state.json целиком. Если на сервере
         уже было что-то новее локальной копии — оно стиралось этим же
         нажатием "Обновить", ровно наоборот тому, что кнопка обещает.
         Теперь сначала pull+слияние по записям, потом push уже
         объединённого результата. */
      Promise.race([
        Storage.pull().then(function (remote) {
          if (remote) state = normalize(Storage.merge(state, remote));
          return Storage.push(state);
        }),
        timeout
      ]).then(function () {
        Storage.writeLocal(state);
        render();
        setSyncDot('ok');
        label.textContent = 'Обновлено ✓';
        PCLog.info('Обновление вручную: успешно');
      }).catch(function (e) {
        setSyncDot('err');
        label.textContent = 'Не вышло: ' + e.message;
        PCLog.error('Обновление вручную не удалось: ' + e.message);
      }).finally(function () {
        btn.disabled = false;
        btn.classList.remove('spinning');
        setTimeout(function () {
          if (label.textContent.indexOf('Обновляю') === -1) label.textContent = 'Обновить';
        }, 3000);
      });
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
          ? 'Досчитал ' + r.added + ' ' + plural(r.added, 'видео', 'видео', 'видео')
          : 'Всё совпадает, расхождений нет';
        refreshVideoIndex();
      }).catch(function (e) {
        el.className = 'status-line err';
        el.textContent = e.message;
      });
    });

    $('#cfg-cleanup-now').addEventListener('click', function () {
      var el = $('#cfg-cleanup-status');
      el.className = 'status-line';
      el.textContent = 'Проверяю и чищу…';
      PCLog.info('Ручной запуск очистки старых видео');
      Storage.video.cleanupNow().then(function (r) {
        el.className = 'status-line ok';
        el.textContent = r.removed
          ? 'Удалено ' + r.removed + ' ' + plural(r.removed, 'старое видео', 'старых видео', 'старых видео') + ' — очистка реально работает'
          : 'Нечего удалять — всё видео в пределах срока хранения';
        PCLog.info('Ручная очистка: удалено ' + (r.removed || 0));
        refreshVideoIndex();
      }).catch(function (e) {
        el.className = 'status-line err';
        el.textContent = e.message;
        PCLog.error('Ручная очистка не удалась: ' + e.message);
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
    initChatKeyboardOffset();
    tick();
    setInterval(tick, 1000);

    if (!myId()) openIdentityGate();

    /* если день сменился, пока приложение висело в фоне; и досылаем
       несохранённые изменения, если страница как раз в этот момент
       уходит из вида (см. flushOnHide) */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { flushOnHide(); return; }
      if (cursor > today()) cursor = today();
      render();
      refreshVideoIndex();
      resumePendingVideos();
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
    /* Запасной путь: на части браузеров при полном закрытии страницы
       visibilitychange может не успеть, а pagehide — более надёжный
       последний шанс досохранить. */
    window.addEventListener('pagehide', flushOnHide);

    Storage.pull().then(function (remote) {
      if (!remote) return;
      state = normalize(Storage.merge(state, remote));
      render();
    }).catch(function () {});
    refreshVideoIndex();
    resumePendingVideos();

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {});
      });
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
