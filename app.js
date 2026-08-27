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
  var chatReadState = {}; // {participantId: lastReadSeq} — курсоры прочитанного, см. счётчик "N/4" в чате
  /* Держится ли сейчас лента "прилипшей" к низу — правда только пока
     юзер реально внизу (или только что открыл чат). Картинки/видео из
     скрепки догружаются асинхронно (presigned-ссылка) уже ПОСЛЕ того,
     как renderChat/scrollChatToBottom отработали, и своим появлением
     дальше отодвигают настоящий низ — без этого флага лента оставалась
     прокрученной туда, где низ был ДО их загрузки (визуально: последний
     пузырь висит где-то посередине). См. setCardMedia ниже. */
  var chatStickToBottom = true;
  var chatPollTimer = null;

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
  /* Тап по статусу — самое частое и самое важное изменение в
     приложении, по прямому запросу пишется в облако СРАЗУ (не через
     обычную задержку в 900 мс у commit()/flushSave, см. ниже), с явным
     статусом "Записываю…/Записано/Ошибка записи" и настоящим откатом
     конкретной записи (не всего state), если запись не удалась —
     чтобы на экране никогда не оставалась галочка, которая на самом
     деле не сохранилась. */
  function setStatus(p, date, status) {
    var prevRec = state.days[date] ? state.days[date][p.id] : undefined;

    if (!state.days[date]) state.days[date] = {};
    /* Раньше при снятии статуса (второй тап по уже активной кнопке)
       запись просто УДАЛЯЛАСЬ локально — и вместе с ней пропадал сам
       факт, что что-то поменялось: следующая отправка на сервер молча
       ничего не говорила об этой ячейке, старый статус так и оставался
       в day_marks на chatstore и возвращался обратно при следующей
       синхронизации — снять отметку было физически нельзя. Теперь
       снятие — это явная запись {status: null, at: ...}, такая же
       "настоящая" смена, как и любая другая, только со значением null;
       chatstore теперь понимает null как команду удалить строку (см.
       chatstore/app.py). statusOf()/остальной код уже трактует
       status:null как "не отмечено", отдельно ничего чинить не пришлось. */
    state.days[date][p.id] = { status: status || null, at: new Date().toISOString() };

    state.updatedAt = new Date().toISOString();
    Storage.writeLocal(state);
    render();
    clearTimeout(saveTimer); // эта отметка уже уходит немедленно — отложенному commit() досылать нечего
    saveStatusImmediately(date, p.id, prevRec, status, p);
  }

  function showSaveStatus(kind, text) {
    var el = $('#save-status');
    if (!el) return;
    clearTimeout(showSaveStatus._hideTimer);
    el.className = 'save-status ' + kind;
    el.innerHTML = '<span class="dot"></span>' + esc(text);
    el.hidden = false;
    if (kind === 'ok') {
      showSaveStatus._hideTimer = setTimeout(function () { el.hidden = true; }, 2000);
    }
  }

  function saveStatusImmediately(date, participantId, prevRec, status, p) {
    showSaveStatus('pending', 'Записываю…');
    setSyncDot('pending');
    Storage.pull().then(function (remote) {
      if (remote) {
        state = normalize(Storage.merge(state, remote));
        Storage.writeLocal(state);
      }
      return Storage.push(state);
    }).then(function (r) {
      if (r && r.synced) {
        PCLog.info('Отметка записана');
        showSaveStatus('ok', 'Записано ✓');
        setSyncDot('ok');
        render();
        /* По прямому запросу — как и с видео, отметка нормы/альт/форс/
           пропуск тоже сопровождается сообщением в общем чате. Только
           при УСТАНОВКЕ (status truthy) — снятие отметки (повторный тап)
           отдельно не анонсируем, это не то событие, которое интересно
           остальным. Best-effort, как и везде с chatAnnounce. */
        if (status && p) {
          chatAnnounce(participantId, GLYPH[status] + ' ' + p.name + ' — «' + LABEL[status] + '» за ' + shortDate(date));
        }
      } else {
        showSaveStatus('err', 'Облако не настроено — сохранено только на этом телефоне');
        setSyncDot('local');
      }
    }).catch(function (e) {
      // Настоящий откат — возвращаем именно эту ячейку (дата+участник) к тому,
      // что было до тапа, а не весь state целиком (остальные правки, если
      // они были, отката не касаются — тот же принцип, что и в Storage.merge).
      if (prevRec) {
        if (!state.days[date]) state.days[date] = {};
        state.days[date][participantId] = prevRec;
      } else if (state.days[date]) {
        delete state.days[date][participantId];
        if (!Object.keys(state.days[date]).length) delete state.days[date];
      }
      Storage.writeLocal(state);
      render();
      PCLog.error('Не удалось записать отметку: ' + e.message);
      showSaveStatus('err', 'Ошибка записи: ' + e.message);
      setSyncDot('err');
    });
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
      /* !== undefined тут раньше пропускал null — а сервер (chatstore)
         честно отдаёт SQL NULL как JSON null, не как отсутствие ключа.
         Один раз так и вышло на боевых данных: anchor/fine/altLimit/
         maxMult/deadline пришли null-ями (после ручного сброса конфига
         на сервере при разработке), null просуществовал в out поверх
         нормального умолчания, и multiplier() потом считал Math.min(x,
         null) — null в числовом сравнении ведёт себя как 0, у всех
         обнулились нормы. updatedAt — намеренное исключение: null там
         означает "ещё не сохранялось" и это ЛЕГИТИМНОЕ значение по
         умолчанию, не "забыли прислать". */
      Object.keys(DEFAULTS).forEach(function (k) {
        if (k === 'updatedAt') { if (s[k] !== undefined) out[k] = s[k]; return; }
        if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
      });
      if (!Array.isArray(out.participants) || !out.participants.length) out.participants = DEFAULTS.participants;
      if (!out.days || typeof out.days !== 'object') out.days = {};
    }
    return out;
  }

  /* ============================================================
     Отрисовка — Сегодня
     ============================================================ */
  var $ = function (s) { return document.querySelector(s); };

  /* Видео-блок ОДНОГО участника — раньше рендерился отдельно ото всех,
     общим списком под всеми карточками. По прямому запросу — сразу под
     карточкой именно этого человека, чтобы не листать вниз, сопоставляя,
     где чьё видео. */
  function renderParticipantVideoRow(p, date, canRecord) {
    if (!Storage.video.supported()) return '';
    var gone = !activeOn(p, date);
    var clips = videoIndex.items.filter(function (v) { return v.participantId === p.id && v.date === date; });
    var thumbs = clips.map(function (v) {
      var inner = v.thumb ? '<img src="' + v.thumb + '" alt="">' : '▶';
      /* Число повторений: у чужих и у уже заполненных — просто плашка.
         У своих, где число НЕ указано — кликабельное «?»: снял, залил,
         указать забыл. Переписать уже проставленное нельзя (и на
         бэкенде тоже, см. action_update_video_reps) — иначе это способ
         тихо подправить свой зачёт после того, как его увидели. */
      var reps = v.reps
        ? '<span class="vid-reps">' + v.reps + '</span>'
        : (v.participantId === myId()
            ? '<span class="vid-reps ask" data-setreps="' + v.id + '" data-repsdate="' + v.date + '" title="Указать количество повторений">?</span>'
            : '');
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
    if (!thumbs && !addBtn) return '';
    return '<div class="vid-row"><div class="clips">' + thumbs + addBtn + '</div></div>';
  }

  function renderToday() {
    var date = cursor;
    $('#d-label').textContent = (date === today() ? 'Сегодня — ' : '') + human(date);
    $('#d-next').disabled = date >= today();

    var host = $('#today-cards');
    host.innerHTML = '';
    var canRecord = Storage.video.supported() && PCVideo.supported();

    /* По алфавиту — по прямому запросу (раньше был порядок как в
       настройках/state.participants, произвольный). localeCompare с
       локалью 'ru', чтобы Ё и прочие буквы сортировались правильно. */
    var sorted = state.participants.slice().sort(function (a, b) { return a.name.localeCompare(b.name, 'ru'); });

    sorted.forEach(function (p) {
      var gone = !activeOn(p, date);
      var t = task(p, date);
      var st = statusOf(p, date);
      var used = altUsed(p, date);

      /* Карточка + видео-блок этого же участника едут одной группой —
         внешний отступ (до следующего участника) висит на группе целиком,
         а между самой карточкой и её видео зазора нет вообще (по прямому
         запросу — раньше между ними оставался обычный межблочный отступ,
         как будто это два разных, не связанных друг с другом блока). */
      var group = document.createElement('div');
      group.className = 'p-group';

      var card = document.createElement('div');
      card.className = 'card' + (gone ? ' gone' : '');

      var badges = '';
      if (t.mult > 1) badges += '<span class="badge mult' + (t.mult >= 4 ? ' m4' : t.mult === 3 ? ' m3' : '') + '">Отработка ×' + t.mult + '</span>';
      if (st) badges += ' <span class="badge ' + st + '">' + LABEL[st] + '</span>';

      /* X/N — сколько реально сделано (сумма повторений из ВСЕХ видео
         этого участника за этот день, roликов может быть несколько) из
         нужного по норме на сегодня. Раньше показывали только N (саму
         норму) — по прямому запросу теперь виден и фактический прогресс. */
      var doneReps = videoIndex.items
        .filter(function (v) { return v.participantId === p.id && v.date === date; })
        .reduce(function (sum, v) { return sum + (v.reps || 0); }, 0);

      var repsLine = gone
        ? '<span class="ex">вышел из челленджа</span>'
        : '<b>' + doneReps + '/' + t.reps + '</b> <span class="ex">' + EXNAME[t.ex] + (t.mult > 1 ? ' (' + t.base + '×' + t.mult + ')' : '') + '</span>';

      var body =
        '<div class="head">' +
          '<div class="name">' + p.name + '</div>' +
          '<div class="stat">' +
            '<div class="reps-line">' + repsLine + '</div>' +
            (badges ? '<div class="badges-inline">' + badges + '</div>' : '') +
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
      group.appendChild(card);

      var videoRow = renderParticipantVideoRow(p, date, canRecord);
      if (videoRow) group.insertAdjacentHTML('beforeend', videoRow);

      host.appendChild(group);
    });

    host.querySelectorAll('.status-row button').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.p !== myId()) return;
        var p = state.participants.filter(function (x) { return x.id === b.dataset.p; })[0];
        setStatus(p, cursor, statusOf(p, cursor) === b.dataset.s ? null : b.dataset.s);
      });
    });
    host.querySelectorAll('[data-rec]').forEach(function (b) {
      b.addEventListener('click', function () { openRecorder(b.dataset.rec); });
    });
    host.querySelectorAll('[data-play]').forEach(function (b) {
      b.addEventListener('click', function () { openPlayer(b.dataset.play, b.dataset.who, b.dataset.reps); });
    });
    host.querySelectorAll('[data-setreps]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();   // не открывать плеер — тап именно по плашке
        askRepsForVideo(b.dataset.setreps, b.dataset.repsdate);
      });
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

    var left = state.participants.filter(function (p) { return p.leftAt; });
    $('#today-banner').innerHTML = left.length
      ? '<div class="empty" style="margin-top:12px;border-color:var(--signal);color:var(--signal)">Челлендж завершён: ' +
        left.map(function (p) { return p.name; }).join(', ') + ' вышел ' + shortDate(left[0].leftAt) + '.</div>'
      : '';

    var hintHost = $('#today-videos');
    if (hintHost) {
      hintHost.innerHTML = !Storage.video.supported()
        ? '<div class="empty">Видео работают только при включённой облачной синхронизации — настрой её на вкладке «Настройки».</div>'
        : (videoIndex.retentionDays
          ? '<p class="vid-empty-hint">Видео хранятся ' + videoIndex.retentionDays + ' ' +
            plural(videoIndex.retentionDays, 'день', 'дня', 'дней') + ', потом удаляются автоматически.</p>'
          : '');
    }
  }

  function refreshVideoIndex() {
    if (!Storage.video.supported()) return Promise.resolve();
    return Storage.video.list().then(function (r) {
      videoIndex = r || { items: [], retentionDays: 0 };
      renderToday();
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
      cancelRecordingCountdown(); // иначе таймер мог бы дозвонить и стартовать запись уже после закрытия
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

  /* Обратный отсчёт 10…1 перед стартом записи — по образцу штатного
     "Таймера" в камере iPhone. Камера уже работает и показывает
     картинку всё это время (см. openRecorder/openCamera) — отсчёт
     только откладывает МОМЕНТ вызова PCVideo.startRecording, ничего
     больше не меняет в самой логике записи/загрузки. Повторный тап по
     кнопке во время отсчёта — отмена (как и на iPhone), а не игнор. */
  var RECORD_COUNTDOWN_SECONDS = 10;

  function cancelRecordingCountdown() {
    if (recSession && recSession.countdownTimer) {
      clearInterval(recSession.countdownTimer);
      recSession.countdownTimer = null;
    }
    var el = $('#rec-countdown');
    if (el) el.hidden = true;
  }

  function startRecordingCountdown() {
    $('#rec-toggle').textContent = '✕ Отмена';
    $('#rec-flip').disabled = true;
    $('#rec-gallery').disabled = true;
    $('#rec-settings-row').hidden = true;

    var el = $('#rec-countdown');
    var n = RECORD_COUNTDOWN_SECONDS;
    el.textContent = n;
    el.hidden = false;

    recSession.countdownTimer = setInterval(function () {
      // recSession мог стать null, если оверлей закрыли между тиками
      // (closeRecorder уже вызвал cancelRecordingCountdown и снял
      // интервал — но лишняя проверка ничего не стоит и подстраховывает
      // от любых будущих путей закрытия, которые могли бы забыть это сделать)
      if (!recSession) return;
      n--;
      if (n <= 0) {
        clearInterval(recSession.countdownTimer);
        recSession.countdownTimer = null;
        el.hidden = true;
        beginRecordingNow();
        return;
      }
      el.textContent = n;
    }, 1000);
  }

  function toggleRecordingUI() {
    if (!recSession || !recSession.stream) return;
    if (recSession.recording) {
      if (recSession.ctrl) recSession.ctrl.stop();
      return;
    }
    if (recSession.countdownTimer) {
      // повторный тап во время отсчёта — отмена, возврат к обычному
      // состоянию "готов снимать", как будто отсчёт и не начинался
      cancelRecordingCountdown();
      setToggleIdle();
      $('#rec-flip').disabled = false;
      $('#rec-gallery').disabled = false;
      $('#rec-settings-row').hidden = false;
      return;
    }
    startRecordingCountdown();
  }

  /* То же самое, что раньше делала toggleRecordingUI() сразу по тапу —
     теперь вызывается либо по окончании отсчёта, либо (когда отсчёт
     когда-нибудь захотят убрать/обойти) можно звать напрямую. Логика
     самой записи/сохранения НЕ менялась ни на строчку. */
  function beginRecordingNow() {
    if (!recSession) return;
    recSession.recording = true;
    setToggleIdle(); // тот же текст "● Запись", кнопка снова означает "Стоп" по нажатию — как и было
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
    var sizeStr = formatFileSize(blob.size);
    var warn = blob.size > 15 * 1024 * 1024 ? ' Файл тяжёлый — загрузка может занять время.' : '';
    $('#rec-msg').textContent = 'Готово, ' + sizeStr + '.' + warn;
    grabThumbnail(preview);
  }

  /* Мини-превью для списка «Видео дня» — кадр из самого ролика,
     ужатый до маленькой JPEG-картинки, хранится прямо в записи индекса
     (десятки КБ, отдельная загрузка в S3 не нужна). Best-effort: если
     на каком-то устройстве не получится (редко, но бывает) — просто
     останется без миниатюры, значок «▶» как раньше. */
  /* Баг с чёрными миниатюрами именно у роликов, снятых прямо в
     приложении (MediaRecorder → WebM), и никогда — у роликов из
     галереи (обычно уже готовый MP4): свежесозданный blob от
     MediaRecorder часто физически не декодирует кадр в момент
     currentTime===0, пока браузер не сделает настоящий seek — рисуется
     пустой/чёрный кадр без единой ошибки, canvas.toDataURL успешно
     возвращает валидную, но пустую картинку. У видео из галереи файл
     уже был декодирован плеером раньше (или его контейнер отдаёт
     первый кадр сразу) — оттого разница видна только у "своих" видео.
     Лечится явным seek на небольшое смещение от нуля и захватом кадра
     уже после события 'seeked', а не сразу по 'loadeddata'. */
  /* Чёрные превью возвращались дважды. Первый заход лечил только одну
     причину (нужен явный seek, иначе MediaRecorder-блоб рисует пустой
     кадр) — но брал кадр на 0.15 с от начала, а это ещё до того, как
     камера телефона выставит экспозицию: первые кадры почти всегда
     тёмные, часто полностью чёрные. Плюс запасные таймеры могли
     выстрелить РАНЬШЕ, чем придёт 'seeked', и захватить ровно тот
     чёрный кадр нулевой позиции, который мы и пытались обойти.

     Теперь: берём КАДР ИЗ СЕРЕДИНЫ ролика (там человек уже в кадре и
     экспозиция настроена), проверяем среднюю яркость получившейся
     картинки и, если она почти чёрная, пробуем другие позиции. Запасной
     таймер снят на «капчу без seek» только как самый последний шанс —
     лучше тёмное превью, чем никакого. */
  var THUMB_POSITIONS = [0.5, 0.35, 0.7, 0.2];  // доли длительности: центр, потом соседние
  var THUMB_MIN_BRIGHTNESS = 18;                 // 0..255; ниже — считаем кадр чёрным

  function frameBrightness(ctx, w, h) {
    try {
      var d = ctx.getImageData(0, 0, w, h).data;
      var sum = 0, n = 0;
      /* Каждый 40-й пиксель — считать все незачем, разброс тут не важен,
         важен только сам факт «кадр не чёрный». */
      for (var i = 0; i < d.length; i += 160) {
        sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        n++;
      }
      return n ? sum / n : 0;
    } catch (e) {
      return 255; // getImageData может упасть на «грязном» canvas — тогда не бракуем кадр
    }
  }

  /* Третий заход на чёрные превью — и вот тут настоящая причина, мимо
     которой прошли оба предыдущих. У блоба от MediaRecorder длительность
     в заголовке не записана (поток пишется на лету, размер заранее
     неизвестен), и браузер до первого настоящего seek отдаёт
     duration === Infinity. А ниже в tryPosition() стояла проверка
     `if (!isFinite(dur)) { capture(false); return; }` — то есть на
     собственных роликах приложения код мгновенно хватал кадр БЕЗ seek,
     ровно на нулевой позиции: тот самый чёрный кадр, ради обхода
     которого вся эта машинерия с позициями и яркостью и писалась. У
     видео из галереи (готовый MP4 с нормальным заголовком) duration
     известна сразу — потому баг и выглядел «через раз».

     Классический обход: сикнуть в заведомо недостижимую позицию —
     браузер упрётся в реальный конец записи, после чего duration
     становится известна, и дальше уже можно спокойно целиться в центр. */
  function resolveDuration(videoEl, cb) {
    var dur = videoEl.duration;
    if (isFinite(dur) && dur > 0) { cb(dur); return; }

    var settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      videoEl.removeEventListener('timeupdate', onUpdate);
      videoEl.removeEventListener('durationchange', onUpdate);
      cb(value);
    }
    function onUpdate() {
      var d = videoEl.duration;
      if (isFinite(d) && d > 0) finish(d);
    }
    videoEl.addEventListener('timeupdate', onUpdate);
    videoEl.addEventListener('durationchange', onUpdate);
    try { videoEl.currentTime = 1e7; } catch (e) { /* некоторые блобы не сикаются — уйдём по таймауту */ }
    setTimeout(function () {
      var d = videoEl.duration;
      finish(isFinite(d) && d > 0 ? d : 0);
    }, 1500);
  }

  function grabThumbnail(videoEl) {
    var done = false;
    var attempt = 0;
    var knownDuration = 0;

    function capture(checkBrightness) {
      if (done) return false;
      try {
        var w = 160, h = Math.round(160 * (videoEl.videoHeight / videoEl.videoWidth || 1.33));
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, w, h);

        if (checkBrightness && frameBrightness(ctx, w, h) < THUMB_MIN_BRIGHTNESS) {
          return false; // кадр чёрный — пусть вызывающий попробует другую позицию
        }
        recSession.thumb = canvas.toDataURL('image/jpeg', 0.55);
        done = true;
        return true;
      } catch (e) {
        PCLog.warn('Миниатюра не собралась: ' + e.message);
        return false;
      }
    }

    function tryPosition() {
      if (done) return;
      if (attempt >= THUMB_POSITIONS.length) {
        capture(false); // позиции кончились — берём что есть, даже тёмное
        return;
      }
      /* Длительность уже разобрана в resolveDuration до первого вызова
         (в том числе для Infinity-блобов от MediaRecorder). Если она так
         и не далась — берём фиксированную секунду от начала: это всё
         равно лучше нулевой позиции, где кадр гарантированно чёрный. */
      var seekTo = knownDuration > 0
        ? knownDuration * THUMB_POSITIONS[attempt]
        : 1 + attempt;
      attempt++;

      videoEl.addEventListener('seeked', function () {
        /* requestAnimationFrame — после 'seeked' кадр не всегда уже
           отрисован в элементе, даём браузеру один кадр на отрисовку. */
        requestAnimationFrame(function () {
          if (!capture(true)) tryPosition(); // вышло чёрное — следующая позиция
        });
      }, { once: true });
      try { videoEl.currentTime = seekTo; }
      catch (e) { tryPosition(); }
    }

    function start() {
      resolveDuration(videoEl, function (dur) {
        knownDuration = dur;
        tryPosition();
      });
    }

    if (videoEl.readyState >= 1) start();
    else videoEl.addEventListener('loadedmetadata', start, { once: true });

    /* Последний рубеж: если ни один seek так и не сработал (некоторые
       блобы на некоторых устройствах просто не сикаются) — хоть
       что-нибудь, лучше тёмное превью, чем пустой значок. Времени дано
       с запасом на разбор длительности (до 1.5 с) плюс сами попытки —
       раньше таймер в 2.5 с успевал выстрелить прямо посреди перебора
       позиций и фиксировал тот самый чёрный кадр. */
    setTimeout(function () { capture(false); }, 6000);
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

    $('#rec-timer').hidden = false;
    $('#rec-timer').textContent = 'обработка…';
    $('#rec-msg').textContent = 'Сжимаю видео из галереи (' + formatFileSize(file.size) + ') — займёт примерно столько же времени, сколько длится сам ролик, это не зависание.';

    PCVideo.compressFile(
      file,
      function (secLeft) { $('#rec-timer').textContent = 'ещё ~' + secLeft + ' с'; },
      function (blob, ext) {
        $('#rec-timer').hidden = true;
        showRecordedPreview(blob, ext);
        var ratio = blob.size / file.size;
        var sizeMsg = ' Было ' + formatFileSize(file.size) + ' → стало ' + formatFileSize(blob.size) + '.';
        /* Сжатие технически "прошло" (не пустой файл, не ошибка) — но
           если размер почти не изменился, значит браузер на этом
           устройстве не уважает заданный битрейт для canvas-потока так
           же строго, как для потока с камеры (для живой записи это
           проверено, для сжатия готового файла — другой путь, гарантии
           той же нет). Честно предупреждаем, а не выдаём за успех. */
        if (ratio > 0.6) {
          sizeMsg += ' Сжатие почти не сработало на этом устройстве — файл всё равно тяжёлый, загрузка может занять время.';
          PCLog.warn('Сжатие галереи почти не уменьшило файл: было ' + formatFileSize(file.size) + ', стало ' + formatFileSize(blob.size) + ' (' + Math.round(ratio * 100) + '%)');
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
    if (recSession) recSession.sending = false;  // снятый заново ролик снова можно отправлять
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
    /* Замок на время всей отправки. Без него любая заминка между
       нажатием и началом реальной загрузки (а именно так и вышло, когда
       диалог «норма выполнена?» открывался под модалкой записи и был не
       виден) превращается в: человек жмёт «Отправить» ещё и ещё, и
       каждое нажатие запускает отдельную загрузку того же ролика —
       дубли видео и по сообщению в чат на каждую. */
    if (recSession.sending) return;
    recSession.sending = true;

    var s = recSession;
    var who = participantName(s.participantId);
    var repsVal = parseInt($('#rec-reps').value, 10);
    var meta = { reps: (repsVal > 0 ? repsVal : null), thumb: s.thumb || null };

    /* Норма уже известна приложению (та же task(), что считает число на
       карточке «Сегодня», с учётом отработки после форс-мажора) —
       раз человек всё равно вводит количество повторений к видео,
       грех не сравнить и не предложить сразу закрыть день, вместо
       того чтобы потом отдельно идти отмечать галочку руками. Свой
       диалог (customConfirm), не встроенный confirm() — у стандартного
       кнопки "OK/Отмена" даёт сама ОС, подписать их "Да/Нет" через
       веб-API нельзя физически, только заменой на свою модалку. */
    /* Проверка нормы вынесена в общую maybeOfferCloseDay() — она же
       теперь вызывается, когда число дописывают к уже залитому ролику
       (см. askRepsForVideo). Раньше логика жила только здесь, поэтому
       во втором сценарии предложение закрыть день не появлялось вообще.
       Считаем СУММУ за день, а не повторения одного ролика: норму
       делают подходами (три ролика по 20 при норме 50), по отдельности
       ни один её не достигает. */
    if (meta.reps) {
      /* Страховка: что бы ни случилось с диалогом, отправка обязана
         начаться. Именно на этом шаге всё и вставало намертво — диалог
         открывался под модалкой записи, человек его не видел и ответить
         не мог, промис не разрешался никогда, а видео просто не
         уходило. Даже если такое повторится по другой причине — через
         20 секунд грузим без закрытия дня (норму всегда можно отметить
         руками, потерять сам ролик куда обиднее). */
      var offerDone = false;
      var offerTimeout = setTimeout(function () {
        if (offerDone) return;
        offerDone = true;
        PCLog.warn('Диалог закрытия нормы не ответил за 20 с — отправляю видео без него');
        proceedWithVideoUpload();
      }, 20000);

      maybeOfferCloseDay(s.participantId, s.date, meta.reps).then(function () {
        if (offerDone) return;
        offerDone = true;
        clearTimeout(offerTimeout);
        proceedWithVideoUpload();
      }).catch(function (e) {
        if (offerDone) return;
        offerDone = true;
        clearTimeout(offerTimeout);
        PCLog.warn('Проверка нормы сорвалась (' + e.message + ') — отправляю видео');
        proceedWithVideoUpload();
      });
    } else {
      proceedWithVideoUpload();
    }

    function proceedWithVideoUpload() {
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
      /* Место на диске виртуалки — коротко в том же сообщении, по
         прямому запросу (r.disk приходит вместе с ответом confirm_upload,
         отдельный запрос не нужен, см. Storage.video.upload). */
      var diskSuffix = (r.disk && typeof r.disk.freeGb === 'number')
        ? ' (свободно ' + r.disk.freeGb + '/' + r.disk.totalGb + ' ГБ)'
        : '';
      $('#rec-msg').textContent = (r.confirmed
        ? 'Отправлено'
        : 'Файл сохранён, но подтверждение задержалось — появится в списке само') + diskSuffix;
      PCLog.info('Видео: загружено (' + who + ', confirmed=' + r.confirmed + ')');

      /* По прямому запросу — больше интерактива вокруг видео: карточка
         сразу уходит в общий чат от лица того, кто загрузил, остальные
         получают push и могут реагировать/обсуждать. Это отменяет
         решение v37 (тогда, наоборот, убрали видео из чата) — код
         рендера видео-карточек и сам Storage.chat.sendVideo() с тех
         пор никуда не делись, просто не вызывались. Best-effort — если
         отправка в чат не удалась, само видео уже в S3 и в списке, это
         не повод портить общий результат загрузки. */
      Storage.chat.sendVideo(s.participantId, {
        path: r.path, ext: s.ext, thumb: meta.thumb, reps: meta.reps, date: s.date
      }).catch(function (e) { PCLog.warn('Видео загрузилось, но не отправилось карточкой в чат: ' + e.message); });

      setTimeout(function () {
        closeRecorder();
        refreshVideoIndex();
      }, r.confirmed ? 500 : 1500);
    }).catch(function (e) {
      clearTimeout(slowHint);
      /* Снимаем замок — здесь показывается кнопка «Повторить отправку»,
         и она должна работать. Замок защищает от случайных повторных
         нажатий во время отправки, а не от осознанного повтора после
         честной неудачи. */
      if (recSession) recSession.sending = false;
      $('#rec-msg').textContent = 'Не отправилось после нескольких попыток: ' + e.message + '. Ролик никуда не делся — можно сохранить в галерею или попробовать ещё раз.';
      $('#rec-controls-savefail').hidden = false;
      PCLog.error('Видео: загрузка не удалась (' + who + '): ' + e.message);
      chatAnnounce(s.participantId, '⚠️ Не получилось загрузить видео: ' + e.message);
    });
    } // proceedWithVideoUpload
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

  /* Открытие вложения по короткому тапу — видео идёт в уже существующий
     плеер, фото/файл получают presigned-ссылку (та же механика, что и
     у видео, см. Storage.chat.attachmentUrl → get_download_url) и
     открываются новой вкладкой: браузер сам решает, показать инлайн
     (картинка, PDF) или предложить скачать — ничего изобретать не
     нужно, это стандартное поведение для прямой ссылки на файл. */
  function openAttachment(m, el) {
    if (m.type === 'video') { openPlayer(m.videoPath, participantName(m.participantId), m.videoReps); return; }
    var path = m.attachPath;
    if (!path) return;
    if (attachUrlCache[path]) { window.open(attachUrlCache[path], '_blank'); return; }
    if (el) el.classList.add('loading');
    Storage.chat.attachmentUrl(path).then(function (url) {
      attachUrlCache[path] = url;
      if (el) el.classList.remove('loading');
      window.open(url, '_blank');
    }).catch(function (e) {
      if (el) el.classList.remove('loading');
      PCLog.warn('Не удалось открыть вложение: ' + e.message);
      alert('Не получилось открыть файл: ' + e.message);
    });
  }

  /* Подгрузка превью фото в ленте — сообщения от других участников (или
     свои же после перезагрузки страницы) приходят только с attachPath,
     без localPreview; картинку показываем, как только получена
     presigned-ссылка. Уже отправленные с локальным превью (свежий
     optimistic-рендер) не трогаем — там <img> уже стоит. */
  function loadChatImages(log) {
    log.querySelectorAll('.chat-img-card[data-attach-path]').forEach(function (card) {
      if (card.querySelector('img, video')) return;
      var path = card.dataset.attachPath;
      if (!path) return;
      if (attachUrlCache[path]) { setCardMedia(card, attachUrlCache[path]); return; }
      Storage.chat.attachmentUrl(path).then(function (url) {
        attachUrlCache[path] = url;
        setCardMedia(card, url);
      }).catch(function () { card.innerHTML = '<div class="chat-img-spinner">⚠️</div>'; });
    });
  }
  /* И картинки, и видео из скрепки — один и тот же ленивый presigned-GET,
     разница только в том, какой тег вставляем (data-kind="video" ставит
     renderMessageBody для клипов, см. выше). */
  function setCardMedia(card, url) {
    card.innerHTML = '';
    var isVideo = card.dataset.kind === 'video';
    var el = document.createElement(isVideo ? 'video' : 'img');
    if (isVideo) { el.controls = true; el.playsInline = true; el.preload = 'metadata'; }
    else el.alt = '';
    /* Presigned-ссылка живёт час (см. ExpiresIn в action_get_download_url) —
       если чат открыт дольше и кэш отдал протухшую ссылку, один раз
       принудительно перезапрашиваем свежую, а не оставляем битую картинку/видео. */
    el.onerror = function () {
      if (card.dataset.retried) return;
      card.dataset.retried = '1';
      delete attachUrlCache[card.dataset.attachPath];
      card.innerHTML = ''; // иначе loadChatImages увидит тут же сломанный элемент и решит, что грузить нечего
      loadChatImages(card.parentElement || document);
    };
    /* Догрузка каждой картинки/видео (presigned-ссылка приходит уже
       ПОСЛЕ того, как renderChat/scrollChatToBottom отработали) может
       раздвинуть высоту ленты и оставить низ прокрутки не там, где
       настоящий последний пузырь. Если юзер был приклеен к низу —
       доприклеиваем ещё раз, когда именно этот элемент довычислит
       размер. */
    el.addEventListener(isVideo ? 'loadedmetadata' : 'load', function () {
      if (chatStickToBottom) scrollChatToBottom();
    });
    el.src = url;
    card.appendChild(el);
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
    startGlobalChatSync(); // при первом выборе идентичности на boot() его ещё не было

    $('#whoOverlay').classList.remove('on');
    renderWhoBtn();
    render();

    var text = wasEverSet
      ? '⚠️ На этом телефоне идентичность сбрасывали и выбрали заново: ' + p.name + '. Если это не ты — напиши в чат.'
      : '🔒 ' + p.name + ' закрепил(а) за собой это устройство.';
    chatAnnounce(id, text);
  }

  /* Своя модалка "Да/Нет" вместо встроенного confirm() — у нативного
     диалога подписи кнопок задаёт ОС/браузер, через веб-API их не
     переименовать. Возвращает Promise<boolean>, один диалог за раз
     (overlay переиспользуется, предыдущие обработчики снимаются перед
     новым открытием). */
  function customConfirm(text, yesLabel, noLabel) {
    return new Promise(function (resolve) {
      var overlay = $('#confirmOverlay');
      var yesBtn = $('#confirm-yes'), noBtn = $('#confirm-no');
      $('#confirm-text').textContent = text;
      yesBtn.textContent = yesLabel || 'Да';
      noBtn.textContent = noLabel || 'Нет';

      function cleanup(result) {
        overlay.classList.remove('on');
        yesBtn.removeEventListener('click', onYes);
        noBtn.removeEventListener('click', onNo);
        resolve(result);
      }
      function onYes() { cleanup(true); }
      function onNo() { cleanup(false); }
      yesBtn.addEventListener('click', onYes);
      noBtn.addEventListener('click', onNo);
      overlay.classList.add('on');
    });
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

  /* Взаимодействие с сообщением — "украдено" у Telegram Web по прямому
     запросу: короткий тап по пузырю открывает всплывающее меню действий
     с полосой быстрых реакций сверху (openMessageMenu), долгое нажатие
     (зажатие) сразу включает режим множественного выбора с чекбоксами
     слева у каждой строки (enterSelectMode) — ровно то и в той же
     последовательности, что в референсе. */
  var selectMode = false;   // режим множественного выбора включён
  var selectedIds = {};     // {messageId: true} — что выбрано в этом режиме
  var messageMenuEls = null; // [backdrop, panel] открытого меню действий, если есть
  var LONG_PRESS_MS = 480;
  var LONG_PRESS_MOVE_TOLERANCE = 10; // px — если палец уехал дальше, это скролл, не зажатие
  var attachUrlCache = {}; // attachPath -> presigned GET url, живёт то же время сессии (ссылка на час, см. get_download_url)

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

  /* Только уже поставленные реакции — быстрый тап по чипу переключает
     свою же (снимает/меняет), как и раньше. Добавление НОВОЙ реакции
     на сообщение без своей — теперь через меню действий (тап по
     пузырю → полоса реакций сверху), см. openMessageMenu(). */
  function renderReactions(m) {
    var mine = myId();
    var reactions = m.reactions || {};
    var pills = REACTIONS.map(function (e) {
      var who = reactions[e] || [];
      var isMine = who.indexOf(mine) !== -1;
      if (!who.length) return '';
      return '<button class="react-pill' + (isMine ? ' mine' : '') + '" data-mid="' + m.id + '" data-emoji="' + e + '">' +
             e + ' ' + who.length + '</button>';
    }).join('');
    return pills ? '<div class="msg-reactions">' + pills + '</div>' : '';
  }

  /* Реакция меняет ОДНО сообщение — раньше после неё звали полный
     renderChat() (весь <innerHTML> ленты пересобирался заново), из-за
     чего лента визуально "дёргалась"/перерисовывалась целиком на
     ровном месте. Теперь патчим точечно: только .msg-reactions именно
     этого сообщения, остальной DOM (и текущая прокрутка) не трогаем. */
  /* Якорь прокрутки. Когда у пузыря в середине ленты появляется чип
     реакции, пузырь становится выше — и всё, что НИЖЕ него, уезжает
     вниз, дёргая картинку под пальцем. В Telegram Web этого нет:
     низ остаётся на месте, а лента ВЫШЕ изменения сдвигается вверх.

     Приём ровно один: контейнер вырос на Δ — увеличиваем scrollTop на
     ту же Δ. Тогда всё, что ниже изменения, остаётся на прежнем месте
     на экране, а сдвиг «съедается» сверху, где на него никто не
     смотрит. CSS-свойство overflow-anchor делает это само, но Safari
     его не поддерживает — а у нас всё живёт именно на айфонах, так что
     считаем руками. */
  function withScrollAnchor(fn) {
    var log = document.getElementById('chat-log');
    if (!log) { fn(); return; }
    var before = log.scrollHeight;
    var top = log.scrollTop;
    /* Если человек и так внизу ленты — ничего компенсировать не надо,
       пусть новый чип просто появится, а лента останется прижатой к
       низу (иначе низ бы «отклеился» на высоту чипа). */
    var atBottom = (before - top - log.clientHeight) < 4;
    fn();
    if (atBottom) { log.scrollTop = log.scrollHeight; return; }
    var delta = log.scrollHeight - before;
    if (delta) log.scrollTop = top + delta;
  }

  function patchMessageReactions(messageId, animateEmoji) {
    var row = document.querySelector('.msg-row[data-mid="' + messageId + '"]');
    var m = chatMessages.filter(function (x) { return x.id === messageId; })[0];
    if (!row || !m) return;
    var col = row.querySelector('.msg-col');
    if (!col) return;

    withScrollAnchor(function () {
      var existing = col.querySelector('.msg-reactions');
      var html = renderReactions(m);
      if (!html) { if (existing) existing.remove(); return; }
      if (existing) existing.outerHTML = html; else col.insertAdjacentHTML('beforeend', html);
      col.querySelectorAll('.react-pill').forEach(wireReactPill);
    });

    if (animateEmoji) burstReaction(col, animateEmoji);
  }

  /* Мини-салют вокруг реакции — как в Telegram. Чисто косметика поверх
     уже применённой реакции: несколько копий эмодзи разлетаются и
     тают. Живёт в отдельном слое поверх чипа и сам себя убирает, в
     разметку сообщения не вмешивается (иначе бы снова поехала высота,
     которую мы только что аккуратно зафиксировали якорем). */
  function burstReaction(col, emoji) {
    var pill = col.querySelector('.react-pill[data-emoji="' + emoji + '"]');
    if (!pill) return;
    var rect = pill.getBoundingClientRect();
    var layer = document.createElement('div');
    layer.className = 'react-burst';
    layer.style.left = (rect.left + rect.width / 2) + 'px';
    layer.style.top = (rect.top + rect.height / 2) + 'px';

    for (var i = 0; i < 6; i++) {
      var s = document.createElement('span');
      s.textContent = emoji;
      var angle = (Math.PI * 2 * i) / 6 + (Math.random() * 0.5 - 0.25);
      var dist = 26 + Math.random() * 18;
      s.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      s.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
      s.style.animationDelay = (Math.random() * 60) + 'ms';
      layer.appendChild(s);
    }
    document.body.appendChild(layer);
    setTimeout(function () { layer.remove(); }, 900);
  }

  function wireReactPill(b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var myIdVal = myId();
      var emoji = b.dataset.emoji;
      var mid = b.dataset.mid;
      /* Салютуем только когда реакцию ПОСТАВИЛИ, а не сняли: повторный
         тап по своему же чипу снимает реакцию, и фейерверк на снятие
         выглядел бы странно. Понимаем это по состоянию до запроса. */
      var hadMine = ((chatMessages.filter(function (x) { return x.id === mid; })[0] || {}).reactions || {});
      var wasMine = (hadMine[emoji] || []).indexOf(myIdVal) !== -1;

      Storage.chat.react(myIdVal, mid, emoji).then(function (updated) {
        var m = chatMessages.filter(function (x) { return x.id === mid; })[0];
        if (m) m.reactions = updated.reactions;
        patchMessageReactions(mid, wasMine ? null : emoji);
      }).catch(function (e2) { PCLog.warn('Реакция не отправилась: ' + e2.message); });
    });
  }

  function renderReplyQuote(m) {
    if (!m.replyTo) return '';
    var orig = chatMessages.filter(function (x) { return x.id === m.replyTo; })[0];
    if (!orig) return '<div class="reply-quote" data-scrollto="' + m.replyTo + '"><b>Ответ на сообщение</b></div>';
    var preview = orig.type === 'video' ? '🎥 видео' : orig.type === 'image' ? '🖼 фото' : orig.type === 'file' ? '📎 ' + (orig.attachName || 'файл') : (orig.text || '').slice(0, 80);
    return '<div class="reply-quote" data-scrollto="' + orig.id + '"><b>' + esc(participantName(orig.participantId)) + '</b><span>' + esc(preview) + '</span></div>';
  }

  /* Упоминания @Имя — подсветка в тексте сообщения (см. также
     mention-menu в композере ниже, вставляющий их при наборе). Список
     имён — из тех же четырёх участников, что и everywhere; экранируем
     регэксп-спецсимволы на случай, если имя когда-нибудь их получит.
     Более длинные имена проверяются первыми, чтобы "Иван" не съедал
     префикс "Иванов", если такое имя появится. */
  function renderTextWithMentions(text) {
    text = text || '';
    var names = (state.participants || []).map(function (p) { return p.name; })
      .filter(Boolean).sort(function (a, b) { return b.length - a.length; });
    if (!names.length) return esc(text);
    var pattern = names.map(function (n) { return n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|');
    var re = new RegExp('@(' + pattern + ')(?![а-яёА-ЯЁa-zA-Z])', 'g');
    var out = '', last = 0, m;
    while ((m = re.exec(text))) {
      out += esc(text.slice(last, m.index));
      out += '<span class="mention">@' + esc(m[1]) + '</span>';
      last = m.index + m[0].length;
    }
    out += esc(text.slice(last));
    return out;
  }

  /* Время сообщения хранится в UTC (сервер пишет через time.gmtime()) —
     раньше здесь стоял голый m.at.slice(11,16), который просто вырезал
     часы:минуты ИЗ ЭТОЙ UTC-строки как есть, без перевода в часовой
     пояс читающего. Для Москвы (UTC+3) это давало на экране время на
     3 часа МЕНЬШЕ реального — сообщение "21:24" по факту было отправлено
     в полночь. new Date(m.at) + toLocaleTimeString сам берёт часовой
     пояс браузера/устройства. */
  function formatLocalTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }

  /* Счётчик прочитавших — "N/4" или "+", если прочитали все. Только у
     своих сообщений (по прямому запросу, как галочки раньше были только
     у .bubble.out). Отправитель считается прочитавшим своё же
     сообщение всегда, даже если его собственный курсор read_state ещё
     формально не продвинулся дальше — иначе на только что отправленном
     сообщении было бы видно "0/4", что вводит в заблуждение. Список
     "кто именно" — та же арифметика, см. readersOf() и меню "Кто
     прочитал" в openMessageMenu(). */
  function readersOf(m) {
    var readers = {};
    Object.keys(chatReadState).forEach(function (pid) { if (chatReadState[pid] >= m.seq) readers[pid] = true; });
    readers[m.participantId] = true;
    return Object.keys(readers);
  }
  function renderReadCount(m) {
    var total = (state.participants || []).length;
    if (!total) return '';
    var count = readersOf(m).length;
    var label = count >= total ? '+' : (count + '/' + total);
    return ' <span class="read-count">' + label + '</span>';
  }

  /* Курсоры прочитанного (chatReadState) меняются почти на каждом опросе
     чата — кто угодно мог просто открыть вкладку и продвинуть свой
     курсор — а раньше ЛЮБОЕ такое изменение вызывало полный renderChat()
     (целиком пересобранный <innerHTML>, заново навешанные слушатели,
     заново задёрганная прокрутка). Именно это выглядело как "лента
     дёргается/перерисовывается сама по себе" — визуально ничего не
     менялось, кроме счётчика "N/4" у собственных сообщений. Патчим
     только эти счётчики точечно, без перерисовки всего остального. */
  function patchReadCounts() {
    var myIdVal = myId();
    var total = (state.participants || []).length;
    if (!total) return;
    chatMessages.forEach(function (m) {
      if (m.participantId !== myIdVal || m.pending || !m.seq) return;
      var el = document.querySelector('.msg-row[data-mid="' + m.id + '"] .read-count');
      if (!el) return;
      var count = readersOf(m).length;
      el.textContent = count >= total ? '+' : (count + '/' + total);
    });
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    var kb = Math.round(bytes / 1024);
    return kb > 1024 ? (kb / 1024).toFixed(1) + ' МБ' : kb + ' КБ';
  }

  function renderMessageBody(m, time) {
    if (m.type === 'video') {
      var thumb = m.videoThumb ? '<img src="' + m.videoThumb + '" alt="">' : '<div class="chat-vid-noimg">▶</div>';
      var reps = m.videoReps ? '<span class="chat-vid-reps">' + m.videoReps + ' повт.</span>' : '';
      var caption = m.text ? '<div class="bubble-text">' + renderTextWithMentions(m.text) + '<span class="msg-time-inline">' + time + '</span></div>' : '<div class="msg-time-inline" style="float:none;display:block;text-align:right;margin-top:3px;">' + time + '</div>';
      return '<button class="chat-vid-card" data-play="' + m.videoPath + '" data-who="' + esc(participantName(m.participantId)) + '" data-reps="' + (m.videoReps || '') + '">' +
             thumb + '<span class="chat-vid-play">▶</span>' + reps + '</button>' + caption;
    }
    if (m.type === 'image') {
      var imgCaption = m.text
        ? '<div class="bubble-text">' + renderTextWithMentions(m.text) + '<span class="msg-time-inline">' + time + '</span></div>'
        : '<div class="msg-time-inline" style="float:none;display:block;text-align:right;margin-top:3px;">' + time + (m.pending ? ' · отправка…' : '') + '</div>';
      var imgInner = m.localPreview ? '<img src="' + m.localPreview + '" alt="">' : '<div class="chat-img-spinner">⏳</div>';
      return '<div class="chat-img-card" data-attach-path="' + esc(m.attachPath || '') + '">' + imgInner + '</div>' + imgCaption;
    }
    /* Видео, выбранное через скрепку ("Фото или видео" → любой файл с
       video/*-mime) — раньше уходило тем же типом 'file', что и обычный
       документ, и показывалось безликим файл-чипом вместо превью.
       Рендерим как встроенный <video controls>, тем же ленивым
       presigned-GET, что и у картинок (см. loadChatImages/setCardMedia). */
    if (m.type === 'file' && m.attachMime && m.attachMime.indexOf('video/') === 0) {
      var clipCaption = m.text
        ? '<div class="bubble-text">' + renderTextWithMentions(m.text) + '<span class="msg-time-inline">' + time + '</span></div>'
        : '<div class="msg-time-inline" style="float:none;display:block;text-align:right;margin-top:3px;">' + time + (m.pending ? ' · отправка…' : '') + '</div>';
      var clipInner = m.localPreview
        ? '<video src="' + m.localPreview + '" controls playsinline preload="metadata"></video>'
        : '<div class="chat-img-spinner">⏳</div>';
      return '<div class="chat-img-card chat-clip-card" data-kind="video" data-attach-path="' + esc(m.attachPath || '') + '">' + clipInner + '</div>' + clipCaption;
    }
    if (m.type === 'file') {
      var sizeStr = formatFileSize(m.attachSize) + (m.pending ? ' · отправка…' : '');
      return '<button class="chat-file-card" data-attach-path="' + esc(m.attachPath || '') + '">' +
               '<span class="chat-file-icon">📄</span>' +
               '<span class="chat-file-info"><span class="chat-file-name">' + esc(m.attachName || 'Файл') + '</span>' +
               '<span class="chat-file-size">' + sizeStr + '</span></span>' +
             '</button><span class="msg-time-inline" style="float:none;display:block;text-align:right;margin-top:3px;">' + time + '</span>';
    }
    return '<div class="bubble-text">' + renderTextWithMentions(m.text) + '<span class="msg-time-inline">' + time + (m.pending ? ' · отправка…' : '') + '</span></div>';
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

    closeMessageMenu(); // список может пересобраться под открытым меню — не оставляем меню "повисшим"

    var log = $('#chat-log');
    /* .chat-log — единственный скроллер чата (см. scrollChatToBottom). */
    var chatElForBottom = document.getElementById('chat-log');
    var wasAtBottom = chatElForBottom
      ? (chatElForBottom.scrollHeight - chatElForBottom.scrollTop - chatElForBottom.clientHeight) < 80
      : true;

    var divider = computeUnreadDivider(myId);

    log.classList.toggle('selecting', selectMode);

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
      var time = formatLocalTime(m.at);
      if (mine && !m.pending && m.seq) time += renderReadCount(m);

      var avatarHtml = mine ? '' : (isGroupEnd
        ? '<div class="msg-avatar" style="background:' + participantColor(m.participantId) + '">' + participantInitial(m.participantId) + '</div>'
        : '<div class="avatar-spacer"></div>');
      var senderHtml = (isGroupStart && !mine)
        ? '<div class="msg-sender-inline" style="color:' + participantColor(m.participantId) + '">' + esc(participantName(m.participantId)) + '</div>'
        : '';

      var selected = !!selectedIds[m.id];
      var checkHtml = (selectMode && !m.pending) ? '<div class="msg-select-check' + (selected ? ' checked' : '') + '"></div>' : '';

      var rowCls = 'msg-row' + (mine ? ' mine' : '') + (isGroupStart ? ' group-start' : '') + (selected ? ' selected' : '');
      var bubbleCls = 'bubble' + (mine ? ' out' : ' in') + (m.pending ? ' pending' : '');

      return sep +
        '<div class="' + rowCls + '" id="msg-' + m.id + '" data-mid="' + m.id + '">' + checkHtml + avatarHtml +
          '<div class="msg-col">' +
            '<div class="' + bubbleCls + '" data-mid="' + m.id + '">' + senderHtml + renderReplyQuote(m) + renderMessageBody(m, time) + '</div>' +
            (m.pending ? '' : renderReactions(m)) +
          '</div>' +
        '</div>';
    }).join('');

    log.querySelectorAll('.reply-quote[data-scrollto]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var target = document.getElementById('msg-' + b.dataset.scrollto);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.add('flash');
        setTimeout(function () { target.classList.remove('flash'); }, 900);
      });
    });

    /* Открытие видео/фото/файла теперь целиком идёт через
       wireMessagePress ниже (единая логика короткий тап/зажатие для
       всех вложений) — отдельного click-слушателя на [data-play] тут
       больше нет, иначе клик срабатывал бы дважды. */
    loadChatImages(log);

    log.querySelectorAll('.react-pill').forEach(wireReactPill);

    /* Тап по строке — либо переключает выбор (в режиме выбора), либо
       открывает меню действий. Зажатие (долгий тап) на пузыре сразу
       включает режим выбора, минуя меню — так же, как в референсе. */
    log.querySelectorAll('.msg-row[data-mid]').forEach(function (row) {
      var mid = row.dataset.mid;
      var mObj = chatMessages.filter(function (x) { return x.id === mid; })[0];
      if (!mObj || mObj.pending) return;
      var bubbleEl = row.querySelector('.bubble');
      wireMessagePress(row, bubbleEl, mObj);
    });

    /* Не голый window.scrollTo сразу здесь — document.body.scrollHeight
       в этот самый момент ещё может отражать раскладку ДО того, как
       браузер применил только что вставленный innerHTML (та же причина,
       что чинили в v27 для открытия вкладки, см. scrollChatToBottom).
       Без двойного requestAnimationFrame это иногда промахивалось мимо
       низа — после своей реакции или отправки казалось, что чат
       "прыгнул" в центр/куда-то повыше вместо настоящего низа. */
    if (wasAtBottom) scrollChatToBottom();
    renderSelectBar();
    updateScrollBottomBtn();
  }

  /* Долгое нажатие через таймер + отмена при заметном сдвиге пальца
     (иначе обычный скролл ленты воспринимался бы как зажатие). Работает
     и с touch, и с мышью (Pointer Events — один код для обоих). */
  function wireMessagePress(row, bubbleEl, m) {
    var pressTimer = null;
    var startX = 0, startY = 0, longPressed = false;

    function cancelPress() {
      clearTimeout(pressTimer);
      pressTimer = null;
    }

    /* Реакция-чип и цитата ответа — целиком свои, у них уже есть
       собственные click-обработчики (переключить реакцию / проскроллить
       к оригиналу) — зажатие/тап по строке их не трогает вообще.
       Видео/фото/файл — наоборот, участвуют в общей логике: короткий
       тап открывает контент напрямую (плеер/просмотр/скачивание) вместо
       меню, а зажатие на них так же включает выбор, как и на любом
       другом месте пузыря. */
    /* <video> с native controls (клип из скрепки) сам разбирается с
       тапами/скрабом по себе — не даём зажатию/тапу по строке
       перехватывать нажатия на его собственные play/scrub/громкость. */
    function isOwnControl(e) { return !!e.target.closest('.react-pill, .reply-quote, video'); }
    function attachTarget(e) { return e.target.closest('.chat-vid-card, .chat-img-card, .chat-file-card'); }

    row.addEventListener('pointerdown', function (e) {
      longPressed = false;
      if (e.button !== undefined && e.button !== 0) return; // только левая кнопка/тач
      if (isOwnControl(e)) return;
      startX = e.clientX; startY = e.clientY;
      pressTimer = setTimeout(function () {
        longPressed = true;
        pressTimer = null;
        if (navigator.vibrate) navigator.vibrate(15);
        if (!selectMode) enterSelectMode(m.id);
        else toggleSelect(m.id);
      }, LONG_PRESS_MS);
    });
    row.addEventListener('pointermove', function (e) {
      if (!pressTimer) return;
      if (Math.abs(e.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE) {
        cancelPress();
      }
    });
    row.addEventListener('pointerup', function (e) {
      var wasLong = longPressed;
      cancelPress();
      if (isOwnControl(e)) return;
      if (wasLong) return; // уже обработано в таймере
      if (selectMode) { toggleSelect(m.id); return; }
      var att = attachTarget(e);
      if (att) { openAttachment(m, att); return; }
      if (bubbleEl) openMessageMenu(m, bubbleEl);
    });
    row.addEventListener('pointercancel', cancelPress);
    row.addEventListener('pointerleave', cancelPress);
  }

  /* ============================================================
     Меню действий сообщения — полоса быстрых реакций сверху + список
     действий (Ответить / Копировать / Выбрать / Удалить), точь-в-точь
     последовательность действий как в Telegram Web: короткий тап по
     пузырю. Это отдельный слой поверх всего (position:fixed,
     аппендится в body), а не часть innerHTML ленты — так его не сносит
     очередной renderChat() при приходе нового сообщения, а закрытие
     общее для скролла/новых сообщений через closeMessageMenu().
     ============================================================ */
  function closeMessageMenu() {
    if (!messageMenuEls) return;
    messageMenuEls.forEach(function (el) { el.remove(); });
    messageMenuEls = null;
    window.removeEventListener('scroll', closeMessageMenu);
    window.removeEventListener('resize', closeMessageMenu);
    var chatEl = document.getElementById('chat-log');
    if (chatEl) chatEl.removeEventListener('scroll', closeMessageMenu);
  }

  function openMessageMenu(m, bubbleEl) {
    closeMessageMenu();
    var myIdVal = myId();
    var mine = m.participantId === myIdVal;
    var canCopy = m.type !== 'video' && m.type !== 'image' && m.type !== 'file';

    var backdrop = document.createElement('div');
    backdrop.className = 'msg-menu-backdrop';

    var panel = document.createElement('div');
    panel.className = 'msg-menu-panel';
    panel.innerHTML =
      '<div class="msg-quick-reactions">' + REACTIONS.map(function (e) {
        return '<button class="quick-react" data-emoji="' + e + '">' + e + '</button>';
      }).join('') + '</div>' +
      '<div class="msg-context-menu">' +
        '<button data-act="reply">↩ Ответить</button>' +
        (canCopy ? '<button data-act="copy">📋 Копировать</button>' : '') +
        '<button data-act="select">☑️ Выбрать</button>' +
        (mine && m.seq ? '<button data-act="readby">👁 Кто прочитал</button>' : '') +
        (mine ? '<button data-act="delete" class="danger">🗑 Удалить</button>' : '') +
      '</div>';

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    messageMenuEls = [backdrop, panel];

    var rect = bubbleEl.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    var panelRect = panel.getBoundingClientRect();
    var left = mine ? rect.right - panelRect.width : rect.left;
    left = Math.max(8, Math.min(left, vw - panelRect.width - 8));
    var top = rect.bottom + 8;
    if (top + panelRect.height > vh - 8) top = rect.top - panelRect.height - 8;
    if (top < 8) top = 8;
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';

    backdrop.addEventListener('click', closeMessageMenu);
    window.addEventListener('scroll', closeMessageMenu, { passive: true });
    window.addEventListener('resize', closeMessageMenu);
    var chatElForMenu = document.getElementById('chat-log');
    if (chatElForMenu) chatElForMenu.addEventListener('scroll', closeMessageMenu, { passive: true });

    panel.querySelectorAll('.quick-react').forEach(function (b) {
      b.addEventListener('click', function () {
        closeMessageMenu();
        var emoji = b.dataset.emoji;
        var prev = (m.reactions || {})[emoji] || [];
        var wasMine = prev.indexOf(myIdVal) !== -1;   // повторный тап = снятие, салют не нужен
        Storage.chat.react(myIdVal, m.id, emoji).then(function (updated) {
          var mm = chatMessages.filter(function (x) { return x.id === m.id; })[0];
          if (mm) mm.reactions = updated.reactions;
          patchMessageReactions(m.id, wasMine ? null : emoji);
        }).catch(function (e) { PCLog.warn('Реакция не отправилась: ' + e.message); });
      });
    });
    panel.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.dataset.act;
        closeMessageMenu();
        if (act === 'reply') startReply(m.id);
        else if (act === 'copy') copyMessageText(m);
        else if (act === 'select') enterSelectMode(m.id);
        else if (act === 'readby') openReadByPanel(m);
        else if (act === 'delete') confirmDeleteMessage(m);
      });
    });
  }

  /* "Кто прочитал" — по образцу Telegram Web. Та же арифметика, что и
     у счётчика "N/4" в самой ленте (readersOf), просто вместо числа —
     список всех участников с отметкой. */
  function openReadByPanel(m) {
    var readers = readersOf(m);
    var rows = (state.participants || []).map(function (p) {
      var read = readers.indexOf(p.id) !== -1;
      return '<div class="readby-row' + (read ? '' : ' unread') + '">' +
               '<span class="readby-avatar" style="background:' + participantColor(p.id) + '">' + participantInitial(p.id) + '</span>' +
               '<span class="readby-name">' + esc(p.name) + '</span>' +
               '<span class="readby-status">' + (read ? '✓ прочитано' : 'не видел(а)') + '</span>' +
             '</div>';
    }).join('');
    $('#readby-list').innerHTML = rows || '<p class="h" style="padding:12px 16px">Участников пока нет.</p>';
    $('#readByOverlay').classList.add('on');
  }

  function copyMessageText(m) {
    var text = m.text || '';
    if (!text) return;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .catch(function () {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        ta.remove();
      });
  }

  function confirmDeleteMessage(m) {
    if (!confirm('Удалить сообщение без возможности восстановить?')) return;
    var myIdVal = myId();
    Storage.chat.delete(myIdVal, m.id).then(function () {
      chatRemoveLocal(m.id);
      renderChat();
    }).catch(function (e) { PCLog.error('Не удалось удалить сообщение: ' + e.message); alert('Не получилось удалить: ' + e.message); });
  }

  /* ---------- режим множественного выбора (зажатие) ---------- */
  function enterSelectMode(mid) {
    selectMode = true;
    selectedIds = {};
    if (mid) selectedIds[mid] = true;
    renderChat();
  }
  function exitSelectMode() {
    selectMode = false;
    selectedIds = {};
    renderChat();
  }
  function toggleSelect(mid) {
    if (selectedIds[mid]) delete selectedIds[mid]; else selectedIds[mid] = true;
    renderChat();
  }

  function renderSelectBar() {
    var bar = $('#chat-select-bar');
    if (!bar) return;
    var n = Object.keys(selectedIds).length;
    bar.hidden = !selectMode;
    $('#chat-form').classList.toggle('hidden-by-select', selectMode);
    $('#chat-select-count').textContent = n + ' ' + plural(n, 'выбрано', 'выбрано', 'выбрано');
    var myIdVal = myId();
    var allMine = n > 0 && Object.keys(selectedIds).every(function (id) {
      var m = chatMessages.filter(function (x) { return x.id === id; })[0];
      return m && m.participantId === myIdVal;
    });
    $('#chat-select-delete').disabled = !allMine;
    $('#chat-select-copy').disabled = n === 0;
  }

  function copySelectedMessages() {
    var ids = Object.keys(selectedIds);
    var texts = chatMessages
      .filter(function (m) { return ids.indexOf(m.id) !== -1; })
      .sort(function (a, b) { return (a.at || '') < (b.at || '') ? -1 : 1; })
      .map(function (m) { return participantName(m.participantId) + ': ' + (m.text || (m.type === 'video' ? '🎥 видео' : m.type === 'image' ? '🖼 фото' : m.type === 'file' ? '📎 файл' : '')); });
    if (!texts.length) return;
    (navigator.clipboard ? navigator.clipboard.writeText(texts.join('\n')) : Promise.reject()).catch(function () {});
    exitSelectMode();
  }

  function deleteSelectedMessages() {
    var ids = Object.keys(selectedIds);
    if (!ids.length) return;
    if (!confirm('Удалить ' + ids.length + ' ' + plural(ids.length, 'сообщение', 'сообщения', 'сообщений') + '?')) return;
    var myIdVal = myId();
    Promise.all(ids.map(function (id) {
      return Storage.chat.delete(myIdVal, id).then(function () { chatRemoveLocal(id); }).catch(function (e) {
        PCLog.warn('Не удалось удалить ' + id + ': ' + e.message);
      });
    })).then(function () {
      exitSelectMode();
    });
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  /* isFullSet — это полный список с сервера (не since-довесок): такой
     присылает раз в 4 тика обычный опрос (см. pollChat) и всегда —
     Storage.chat.fetch(null). Только в этом случае можно надёжно
     сказать, что сообщение, которого нет в ответе, но есть локально,
     было удалено — при since-опросе его отсутствие ничего не значит,
     сервер просто не отдаёт то, что было раньше курсора. */
  /* outChanges (необязательный) — сюда складывается, ЧТО именно
     изменилось: { added: [id...], reacted: [id...] }. Нужно, чтобы
     вызывающий мог отличить «пришло новое сообщение» (лента реально
     меняется, нужна пересборка) от «на уже известном сообщении
     поменялись реакции» (достаточно точечно пропатчить один чип).
     Раньше возвращался просто boolean, и эхо собственной реакции от
     сервера запускало полную пересборку ленты — прокрутка улетала
     вниз, лента мерцала. Старые вызовы без третьего аргумента работают
     ровно как раньше. */
  function chatMerge(items, isFullSet, outChanges) {
    if (!items) return false;
    var byId = {};
    chatMessages.forEach(function (m) { byId[m.id] = m; });
    var changed = false;
    var newVideo = false;
    items.forEach(function (m) {
      if (!byId[m.id]) {
        chatMessages.push(m);
        byId[m.id] = m;
        changed = true;
        if (outChanges) outChanges.added.push(m.id);
        /* Видео-карточка в чате — тот же самый ролик, что и в списке
           "N/N" на главной (id видео = id карточки-сообщения, см.
           Storage.chat.sendVideo). Раньше главная страница узнавала о
           видео ДРУГОГО участника только на своём boot()/"Обновить" —
           если открыть приложение раньше, чем кто-то залил ролик, реп
           так и оставался 0 до ручного обновления. Чат уже опрашивается
           непрерывно на всех экранах — используем этот же тик, чтобы и
           видео-индекс подтягивался сам, без отдельного постоянного
           опроса бакета (он тяжелее — полный список S3, см. reconcile
           в backend). */
        if (m.type === 'video') newVideo = true;
      } else if (JSON.stringify(byId[m.id].reactions || {}) !== JSON.stringify(m.reactions || {})) {
        /* Сообщение уже известно — но, например, кто-то другой поставил
           реакцию на него. Обновляем на месте, не просто добавляем новые. */
        byId[m.id].reactions = m.reactions;
        changed = true;
        if (outChanges) outChanges.reacted.push(m.id);
      }
    });
    if (isFullSet) {
      var serverIds = {};
      items.forEach(function (m) { serverIds[m.id] = true; });
      var before = chatMessages.length;
      /* m.pending — сообщение ещё в процессе собственной отправки,
         сервер о нём знать не может, не трогаем. */
      chatMessages = chatMessages.filter(function (m) { return m.pending || serverIds[m.id]; });
      if (chatMessages.length !== before) changed = true;
    }
    if (changed) {
      chatMessages.sort(function (a, b) { return (a.at || '') < (b.at || '') ? -1 : 1; });
      Storage.chat.writeCache(chatMessages);
    }
    if (newVideo) refreshVideoIndex();
    return changed;
  }

  /* Удаление одного сообщения по событию из реального времени — не
     полагаемся на очередной полный опрос, чтобы оно пропало у
     остальных сразу, как и было отправлено (см. action_delete_message
     в backend/index.py, публикует {type:'delete', id}). */
  function chatRemoveLocal(messageId) {
    var before = chatMessages.length;
    chatMessages = chatMessages.filter(function (m) { return m.id !== messageId; });
    if (chatMessages.length === before) return false;
    Storage.chat.writeCache(chatMessages);
    delete selectedIds[messageId];
    return true;
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
      var ch = { added: [], reacted: [] };
      var changed = chatMerge(items, fullPoll, ch);

      /* Курсоры прочитанного — по всем 4 участникам едут вместе с
         сообщениями, отдельного запроса не нужно (см. Storage.chat.fetch).
         Меняются независимо от того, появились ли новые сообщения —
         кто-то мог просто открыть чат и продвинуть свой курсор — так что
         перерисовываем, если счётчики реально изменились, даже без
         новых сообщений. */
      var newReadState = (r && r.readState) || {};
      var readChanged = JSON.stringify(newReadState) !== JSON.stringify(chatReadState);
      if (readChanged) chatReadState = newReadState;

      if (changed || readChanged) {
        var onChatTab = document.getElementById('v-chat').classList.contains('on');
        if (onChatTab && !document.hidden) {
          /* Полная пересборка ленты — только если реально появились
             новые сообщения (или что-то удалили). Если изменились
             ТОЛЬКО реакции на уже известных — патчим их точечно: раньше
             любой такой тик полного опроса (раз в ~32 с) дёргал ленту на
             ровном месте и ронял прокрутку. */
          if (ch.added.length || (changed && !ch.reacted.length)) {
            markChatRead();
            renderChat();
          } else {
            if (ch.reacted.length) ch.reacted.forEach(patchMessageReactions);
            if (readChanged) patchReadCounts();
          }
        } else if (newFromOthers.length) {
          bumpChatUnread(newFromOthers.length);
          notifyNewMessages(newFromOthers);
        }
      }
    }).catch(function (e) { PCLog.warn('Чат: не удалось обновить — ' + e.message); });
  }

  var globalChatSyncStarted = false;

  /* Опрос + реальное время чата — работают всё время, пока выбрана
     идентичность, не только когда открыта вкладка "Чат" (по прямому
     запросу: обновления и бейдж непрочитанных должны приходить, пока
     сидишь где угодно в приложении). Вызывается один раз из boot()
     (если идентичность уже была выбрана раньше) или из
     commitIdentity() (если выбрали только что) — сама идемпотентна,
     повторный вызов ничего не пересоздаёт (startChatPolling делает
     stopChatPolling() перед стартом, connectRealtime выходит сразу,
     если соединение уже есть). */
  function startGlobalChatSync() {
    if (globalChatSyncStarted) return;
    globalChatSyncStarted = true;
    startChatPolling();
    connectRealtime();
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
        if (!data) return;

        if (data.type === 'delete' && data.id) {
          if (chatRemoveLocal(data.id)) {
            closeMessageMenu();
            if (document.getElementById('v-chat').classList.contains('on') && !document.hidden) renderChat();
          }
          return;
        }
        if (!data.message) return;
        /* chatMerge сама разбирается, новое это сообщение или
           обновление реакций на уже известном — но реагировать на эти
           два случая надо ПО-РАЗНОМУ. Раньше и то, и другое вело к
           полной пересборке ленты: поставил реакцию — свой же чип
           обновился точечно (это чинили в v54), а через долю секунды
           прилетало эхо от сервера и всё равно пересобирало ленту
           целиком, роняя прокрутку вниз. Теперь: только реакции —
           патчим точечно, новое сообщение — полная отрисовка. */
        var ch = { added: [], reacted: [] };
        var changed = chatMerge([data.message], false, ch);
        if (!changed) return;

        var onChatTab = document.getElementById('v-chat').classList.contains('on');
        if (!ch.added.length && ch.reacted.length) {
          if (onChatTab && !document.hidden) ch.reacted.forEach(patchMessageReactions);
          return;
        }
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
    /* Best-effort — счётчик "N/4" у остальных чуть задержится, если это
       не удалось, ничего страшного не произошло, поэтому без alert'ов. */
    var myIdVal = myId();
    if (myIdVal) Storage.chat.markRead(myIdVal).catch(function () {});
  }

  function notifyNewMessages(items) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden) return; // приложение и так на экране — хватит бейджа
    try {
      var last = items[items.length - 1];
      var title = items.length > 1 ? ('Чат ПЦ Спорт · ' + items.length + ' новых') : ('Чат ПЦ Спорт · ' + participantName(last.participantId));
      var body = last.type === 'video' ? '🎥 видео' : last.type === 'image' ? '🖼 фото' :
        last.type === 'file' ? '📎 ' + (last.attachName || 'файл') : last.text;
      var n = new Notification(title, { body: body, tag: 'pcsport-chat' });
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
    scrollChatToBottom();
    return Storage.chat.send(myId, text, replyToId, tempId).then(function (msg) {
      /* Раньше здесь было: выбросить оптимистичное сообщение, слить
         пришедшее и позвать renderChat() — то есть ВТОРАЯ полная
         пересборка ленты сразу после первой (а следом нередко третья,
         от эха того же сообщения через Centrifugo). Именно это и
         выглядело как «отправил текст — чат задёргался и замерцал».
         На деле визуально меняется ровно одна вещь: у своего пузыря
         пропадает пометка «отправка…». Патчим её на месте.

         id совпадает: clientId, который мы отправили, — это и есть
         tempId (так сделано ради защиты от дублей, см. v40), поэтому
         сервер возвращает сообщение с тем же id, и подменять узел в
         DOM не нужно. */
      var local = chatMessages.filter(function (x) { return x.id === tempId; })[0];
      if (!local) { chatMerge([msg]); renderChat(); return; }

      Object.keys(msg).forEach(function (k) { local[k] = msg[k]; });
      delete local.pending;
      Storage.chat.writeCache(chatMessages);

      var timeEl = document.querySelector('.msg-row[data-mid="' + tempId + '"] .msg-time-inline');
      if (timeEl) timeEl.textContent = (msg.at || '').slice(11, 16);
      /* Текст "отправка…" патч убирал (см. timeEl выше), а вот сам
         пузырь визуально ОСТАВАЛСЯ приглушённым — CSS-класс .pending
         ставился на .bubble при первом (оптимистичном) рендере и
         никогда не снимался: своё же только что отправленное
         сообщение выглядело "зависшим" ещё несколько секунд/минут,
         пока не подвернётся повод для полного renderChat() (у
         получателя такого не было — оно приходит к нему уже без
         pending с самого начала). Плюс renderChat() изначально НЕ
         вешает тап/зажатие (wireMessagePress) на ещё not-pending
         строки — значит, до следующей полной перерисовки по своему же
         только что отправленному сообщению не открывалось меню
         действий. Оба досадных недочёта — снимаем и довешиваем здесь. */
      var row = document.querySelector('.msg-row[data-mid="' + tempId + '"]');
      if (row) {
        var bubbleEl = row.querySelector('.bubble');
        if (bubbleEl) {
          bubbleEl.classList.remove('pending');
          wireMessagePress(row, bubbleEl, local);
        }
      }
      patchMessageReactions(tempId);
      patchReadCounts();
    }).catch(function (e) {
      PCLog.error('Чат: сообщение не отправилось — ' + e.message);
      var m = chatMessages.filter(function (x) { return x.id === tempId; })[0];
      if (m) { m.pending = false; m.failed = true; m.text += '  [не отправлено]'; }
      renderChat();
    });
  }

  var ATTACH_MAX_SIZE = 30 * 1024 * 1024; // держим в шаге с ATTACH_MAX_SIZE в backend/index.py

  /* Скрепка — «Фото или видео» / «Файл». Та же оптимистичная схема, что
     и у обычного текста (см. sendChatMessage): сразу показываем
     сообщение локально (для фото — с превью через object URL, оно не
     требует сети и живёт мгновенно), грузим в фоне, подменяем на
     подтверждённое от сервера. type — 'image' или 'file', определяется
     тем, через какой пункт меню файл выбрали (см. #attach-menu). */
  /* ============================================================
     Автодополнение @упоминаний в поле ввода — по образцу Telegram Web:
     напечатал "@" (плюс необязательно начало имени) — сверху композера
     всплывает список подходящих участников, тап вставляет "@Имя ".
     Список из тех же четырёх известных участников, что и everywhere —
     без произвольных юзернеймов, их тут просто нет.
     ============================================================ */
  var mentionState = null; // {start, end} — где в тексте сидит текущий "@запрос", пока меню открыто

  function findMentionQuery(text, caret) {
    var head = text.slice(0, caret);
    var m = /@([А-Яа-яЁё]*)$/.exec(head);
    if (!m) return null;
    return { start: m.index, end: caret, query: m[1].toLowerCase() };
  }

  function updateMentionMenu() {
    var input = $('#chat-text');
    var q = findMentionQuery(input.value, input.selectionStart || 0);
    var menu = $('#mention-menu');
    if (!q) { mentionState = null; menu.hidden = true; return; }

    var matches = (state.participants || []).filter(function (p) {
      return p.name.toLowerCase().indexOf(q.query) === 0;
    });
    if (!matches.length) { mentionState = null; menu.hidden = true; return; }

    mentionState = q;
    menu.innerHTML = matches.map(function (p) {
      return '<button type="button" data-pid="' + p.id + '">' +
        '<span class="mention-avatar" style="background:' + participantColor(p.id) + '">' + participantInitial(p.id) + '</span>' +
        '<span>' + esc(p.name) + '</span></button>';
    }).join('');
    menu.hidden = false;
    menu.querySelectorAll('[data-pid]').forEach(function (b) {
      /* mousedown, не click — иначе blur поля ввода (см. ниже) успевает
         спрятать меню раньше, чем долетит клик по кнопке. */
      b.addEventListener('mousedown', function (e) {
        e.preventDefault();
        insertMention(matches.filter(function (p) { return p.id === b.dataset.pid; })[0]);
      });
    });
  }

  function insertMention(p) {
    if (!p || !mentionState) return;
    var input = $('#chat-text');
    var text = input.value;
    var insert = '@' + p.name + ' ';
    input.value = text.slice(0, mentionState.start) + insert + text.slice(mentionState.end);
    var pos = mentionState.start + insert.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    closeMentionMenu();
  }

  function closeMentionMenu() {
    mentionState = null;
    var menu = $('#mention-menu');
    if (menu) { menu.hidden = true; menu.innerHTML = ''; }
  }

  /* ============================================================
     Эмодзи-панель — большой список без раздела «часто используемые»
     (по прямому запросу, попроще, чем в Telegram). Вставляет эмодзи в
     позицию курсора в поле ввода, панель после вставки не закрывается —
     можно подряд натыкать несколько, как обычно и делают.
     ============================================================ */
  var EMOJI_LIST = [
    '😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','😗',
    '😙','😚','🙂','🤗','🤩','🤔','🤨','😐','😑','😶','🙄','😏','😣','😥','😮','🤐',
    '😯','😪','😫','🥱','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🤑',
    '😲','☹️','🙁','😖','😞','😟','😤','😢','😭','😦','😧','😨','😩','🤯','😬','😰',
    '😱','🥵','🥶','😳','🤪','😵','🥴','😠','😡','🤬','😷','🤒','🤕','🤢','🤮','🥳',
    '🥺','🤠','🤡','🥸','🤫','🤭','🧐','🤓','😈','👿','💀','👻','👽','🤖','💩','😺',
    '😸','😹','😻','😼','😽','🙀','😿','😾','👍','👎','👊','✊','🤛','🤜','🤞','✌️',
    '🤟','🤘','👌','🤌','🤏','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤙',
    '💪','🦾','🖕','✍️','🙏','🤝','👏','🙌','👐','🤲','🫡','🫶','❤️','🧡','💛','💚',
    '💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💕','💞','💓','💗','💖','💘','💝','💟',
    '🔥','✨','⭐','🌟','💫','💥','💯','💢','💦','💨','🕳️','💣','💬','👁️‍🗨️','🗨️','🗯️',
    '⚡','☀️','🌤️','⛅','🌧️','⛈️','❄️','☃️','🌈','🎉','🎊','🎁','🏆','🥇','🎯','🚀'
  ];

  function toggleEmojiPicker() {
    var panel = $('#emoji-picker');
    if (!panel.hidden) { panel.hidden = true; return; }
    panel.innerHTML = EMOJI_LIST.map(function (e) { return '<button type="button">' + e + '</button>'; }).join('');
    panel.hidden = false;
    panel.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () { insertEmoji(b.textContent); });
    });
  }
  function closeEmojiPicker() { $('#emoji-picker').hidden = true; }

  function insertEmoji(emoji) {
    var input = $('#chat-text');
    var start = input.selectionStart || input.value.length;
    var end = input.selectionEnd || input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    var pos = start + emoji.length;
    input.setSelectionRange(pos, pos);
    input.focus();
  }

  function sendChatAttachment(file, type) {
    var myIdVal = myId();
    if (!file || !myIdVal) return Promise.resolve();
    if (file.size > ATTACH_MAX_SIZE) {
      alert('Файл больше ' + Math.round(ATTACH_MAX_SIZE / 1024 / 1024) + ' МБ — для длинных видео есть отдельная кнопка «Видео дня».');
      return Promise.resolve();
    }
    var tempId = 'tmp-' + Date.now();
    var replyToId = replyingTo ? replyingTo.id : null;
    /* Локальное превью сразу, без ожидания загрузки/presigned-ссылки —
       раньше делали только для картинок, но видео из скрепки тоже
       получает inline-плеер (см. renderMessageBody), значит и ему
       нужен localPreview, иначе у самого отправителя первые секунды
       будет просто крутилка вместо уже готового на этом же телефоне
       файла. */
    var isVideoAttach = type === 'file' && file.type && file.type.indexOf('video/') === 0;
    var localPreview = (window.URL && (type === 'image' || isVideoAttach)) ? URL.createObjectURL(file) : null;
    var optimistic = {
      id: tempId, participantId: myIdVal, text: '', type: type, at: new Date().toISOString(), pending: true,
      replyTo: replyToId, attachName: file.name, attachSize: file.size, attachMime: file.type, localPreview: localPreview
    };
    chatMessages.push(optimistic);
    clearReply();
    renderChat();
    scrollChatToBottom();

    return Storage.chat.uploadAttachment(myIdVal, file, null).then(function (up) {
      return Storage.chat.sendAttachment(myIdVal, type, {
        path: up.path, name: file.name, mime: file.type || up.contentType, size: file.size
      }, replyToId, tempId);
    }).then(function (msg) {
      chatMessages = chatMessages.filter(function (m) { return m.id !== tempId; });
      chatMerge([msg]);
      renderChat();
      if (localPreview) URL.revokeObjectURL(localPreview);
    }).catch(function (e) {
      PCLog.error('Чат: файл не отправился — ' + e.message);
      var m = chatMessages.filter(function (x) { return x.id === tempId; })[0];
      if (m) { m.pending = false; m.failed = true; m.attachName = (m.attachName || 'файл') + ' [не отправлено]'; }
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
    var preview = replyingTo.type === 'video' ? '🎥 видео' : replyingTo.type === 'image' ? '🖼 фото' :
      replyingTo.type === 'file' ? '📎 ' + (replyingTo.attachName || 'файл') : (replyingTo.text || '').slice(0, 80);
    bar.hidden = false;
    bar.innerHTML = '<div class="reply-bar-txt"><b>' + esc(name) + '</b><br>' + esc(preview) + '</div><button id="chat-reply-cancel">✕</button>';
    $('#chat-reply-cancel').addEventListener('click', clearReply);
    syncChatHeight();
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

  /* Копирование текста в буфер — тот же приём, что и у #log-copy, но
     переиспользуемый (нужен ещё и диагностике виртуалки). */
  function copyTextTo(text, statusEl) {
    var done = function () { statusEl.textContent = 'Скопировано'; statusEl.className = 'status-line ok'; };
    var fail = function () { statusEl.textContent = 'Не удалось скопировать — выдели текст вручную'; statusEl.className = 'status-line err'; };
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
  }

  /* ============================================================
     Диагностика виртуалки — одна кнопка проверяет разом chatstore,
     Centrifugo, MinIO, место на диске, push-подписки, VAPID — см.
     action_health_check в backend/app.py. Лог собирается так, чтобы
     его можно было целиком скопировать и прислать для разбора: не
     только "ок/не ок" по каждой службе, но и КОНТЕКСТ клиента (версия
     приложения, какой именно URL бэкенда настроен у этого конкретного
     человека, идентичность) — путаница "кто на каком бэкенде" уже
     дважды всплывала вживую при переездах (Cloud Function → своя
     виртуалка, потом Yandex S3 → MinIO), без этой строки в логе такое
     приходится выяснять отдельным вопросом.

     Если бэкенд не отвечает вообще (сеть, неверный URL, CORS) —
     проверка НЕ обрывается молча: это тоже строка в логе, причём
     первая и самая важная, с настоящим текстом ошибки браузера. */
  var healthCheckLastText = '';

  function renderHealthLines(lines) {
    var box = $('#health-check-box');
    box.hidden = false;
    box.innerHTML = lines.map(function (l) {
      return '<div class="' + (l.level === 'error' ? 'lvl-error' : '') + '">' + esc(l.text) + '</div>';
    }).join('');
    box.scrollTop = 0;
    healthCheckLastText = lines.map(function (l) { return l.text; }).join('\n');
    $('#health-check-actions').hidden = false;
  }

  function runHealthCheck() {
    var btn = $('#health-check-run');
    var statusEl = $('#health-check-status');
    var box = $('#health-check-box');
    btn.disabled = true;
    box.hidden = false;
    box.innerHTML = '<div style="opacity:.5">Проверяю…</div>';
    $('#health-check-actions').hidden = true;
    statusEl.textContent = '';
    statusEl.className = 'status-line';

    var lines = [];
    function push(text, level) { lines.push({ text: text, level: level || '' }); }

    push('=== ПЦ Спорт — диагностика виртуалки ===');
    push('Собрано: ' + new Date().toLocaleString('ru-RU'));
    push('Версия приложения: ' + ($('#appVersion') ? $('#appVersion').textContent : '?'));
    var cfg = Storage.config.read();
    push('Бэкенд: ' + cfg.backend + (cfg.backend === 'cloud' ? ' — ' + (cfg.url || '(URL не задан)') : ''));
    push('Я (идентичность): ' + (myId() || '(не выбрана)'));
    push('User-Agent: ' + navigator.userAgent);

    Storage.healthCheck().then(function (r) {
      push('');
      push('Время сервера: ' + r.serverTime);
      push('');
      push('--- Проверка служб ---');
      (r.checks || []).forEach(function (c) {
        push((c.ok ? '✅ ' : '❌ ') + c.name + ' — ' + c.detail + ' (' + c.ms + ' мс)', c.ok ? '' : 'error');
      });
      if (r.config) {
        push('');
        push('--- Конфигурация бэкенда ---');
        Object.keys(r.config).forEach(function (k) { push(k + ': ' + r.config[k]); });
      }
      push('');
      push(r.ok ? 'ИТОГ: всё в порядке ✅' : 'ИТОГ: есть проблемы, см. выше ❌', r.ok ? '' : 'error');
      renderHealthLines(lines);
      statusEl.textContent = r.ok ? 'Всё в порядке' : 'Есть проблемы';
      statusEl.className = 'status-line ' + (r.ok ? 'ok' : 'err');
    }).catch(function (e) {
      push('');
      push('❌ НЕ УДАЛОСЬ ПОДКЛЮЧИТЬСЯ К БЭКЕНДУ ВООБЩЕ', 'error');
      push('Ошибка: ' + e.message, 'error');
      push('');
      push('До сервера запрос не дошёл — дальше проверять нечего. Самое');
      push('вероятное: URL в Настройках указывает не туда, либо нет сети.');
      renderHealthLines(lines);
      statusEl.textContent = 'Не удалось подключиться';
      statusEl.className = 'status-line err';
    }).then(function () { btn.disabled = false; });
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
  /* Только текущая версия — по прямому запросу, полную историю хранить
     тут смысла нет (она и так вся есть в README.md, для читателя
     приложения важно только "что изменилось только что"). */
  var CHANGELOG = [
    { v: 'v63', items: [
      'При записи видео теперь обратный отсчёт 10…1 перед стартом — как штатный «Таймер» в камере iPhone; повторный тап по кнопке во время отсчёта отменяет запись'
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
    refreshDiskUsage();
    $('#cfg-papich').checked = papichEnabled();
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

  /* Свободное место на диске виртуалки — видео теперь физически лежат
     там (переезд на своё MinIO), место больше не "бесконечное", как
     было с Yandex. Тихо гасим ошибку — если облако не настроено или
     сервер недоступен, просто не показываем строку, это не авария. */
  function refreshDiskUsage() {
    var el = $('#cfg-disk-usage');
    if (!el) return;
    if (!Storage.video.supported()) { el.textContent = '—'; return; }
    Storage.video.diskUsage().then(function (d) {
      el.textContent = d.usedGb + ' / ' + d.totalGb + ' ГБ занято (свободно ' + d.freeGb + ' ГБ)';
    }).catch(function () { el.textContent = '—'; });
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
  /* ============================================================
     Уведомления — один переключатель на два места (колокольчик на
     «Сегодня» и кнопка в настройках), плюс тихая самопроверка.

     Раньше кнопка умела только включать: выключить уведомления из
     приложения было нельзя вообще, только через системные настройки
     телефона. И отдельно — подписка могла молча отвалиться (браузер
     вправе её отозвать: переустановка PWA, чистка данных сайта,
     ротация ключей на стороне push-службы), а человек об этом узнавал
     только по факту «включал же, а ничего не приходит».

     Флаг «человек хотел уведомления» живёт локально и переживает
     отзыв подписки — именно по нему ensurePushSubscription() понимает,
     что подписку надо тихо восстановить, а не что человек её выключил.
     ============================================================ */
  /* ============================================================
     Повторения у уже залитого видео + проверка нормы.

     Проверка нормы теперь живёт ОТДЕЛЬНО от отправки видео и
     вызывается в момент, когда число повторений реально становится
     известно — и при отправке нового ролика, и когда число дописали к
     старому. Раньше она была намертво вшита в sendRecordingUI(), то
     есть срабатывала только в одном сценарии из двух.
     ============================================================ */

  /* Сумма повторений за день по индексу видео. extraReps — ролик,
     которого в индексе ещё нет (только что отправляется). */
  function dayReps(participantId, date, extraReps) {
    var sum = videoIndex.items
      .filter(function (v) { return v.participantId === participantId && v.date === date; })
      .reduce(function (s, v) { return s + (v.reps || 0); }, 0);
    return sum + (extraReps || 0);
  }

  /* Предложить закрыть день, если сумма за день дотянула до нормы.
     Возвращает промис — вызывающий может дождаться ответа, если ему
     важен порядок (как при отправке видео). */
  function maybeOfferCloseDay(participantId, date, extraReps) {
    var p = state.participants.filter(function (x) { return x.id === participantId; })[0];
    if (!p || statusOf(p, date) === 'done') return Promise.resolve(false);

    var need = task(p, date).reps;
    var total = dayReps(participantId, date, extraReps);
    if (total < need) return Promise.resolve(false);

    return customConfirm('Норма выполнена (' + total + ' из ' + need + ') — закрыть день как «Норма»?')
      .then(function (yes) {
        if (yes) {
          setStatus(p, date, 'done');
          PCLog.info('Норма закрыта по повторениям: ' + participantName(participantId) +
                     ', ' + shortDate(date) + ' (' + total + '/' + need + ')');
        }
        return yes;
      });
  }

  /* Ввод числа повторений для уже залитого ролика. Свой диалог, а не
     window.prompt(): на iOS в установленном на «Экран Домой» PWA
     системный prompt местами не показывается вообще. */
  function askRepsForVideo(videoId, date) {
    var overlay = $('#repsOverlay');
    var input = $('#reps-input');
    var msg = $('#reps-msg');
    input.value = '';
    msg.textContent = '';
    overlay.classList.add('on');
    setTimeout(function () { input.focus(); }, 50);

    function close() {
      overlay.classList.remove('on');
      $('#reps-ok').removeEventListener('click', onOk);
      $('#reps-cancel').removeEventListener('click', close);
    }

    function onOk() {
      var n = parseInt(input.value, 10);
      if (!(n > 0)) { msg.textContent = 'Введи число больше нуля'; return; }
      $('#reps-ok').disabled = true;
      msg.textContent = 'Сохраняю…';
      Storage.video.updateReps(myId(), videoId, n).then(function () {
        PCLog.info('Повторения указаны для видео ' + videoId + ': ' + n);
        $('#reps-ok').disabled = false;
        close();
        /* Обновляем индекс и только потом считаем сумму за день —
           иначе только что вписанное число в подсчёт не попадёт. */
        return refreshVideoIndex().then(function () {
          return maybeOfferCloseDay(myId(), date, 0);
        });
      }).catch(function (e) {
        $('#reps-ok').disabled = false;
        msg.textContent = 'Не получилось: ' + e.message;
        PCLog.error('Не удалось указать повторения: ' + e.message);
      });
    }

    $('#reps-ok').addEventListener('click', onOk);
    $('#reps-cancel').addEventListener('click', close);
  }

  /* Короткое всплывающее сообщение — для действий с главной страницы,
     где нет своей строки статуса (колокольчик). Возвращает объект с той
     же формой, что и обычный status-line элемент, чтобы
     toggleNotifications() не разбирался, откуда его позвали. */
  function toastStatus() {
    var el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    var hideTimer = null;
    return {
      set textContent(v) {
        el.textContent = v;
        el.classList.add('on');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(function () { el.classList.remove('on'); }, 3500);
      },
      set className(v) {
        el.className = 'toast on' + (v.indexOf('err') !== -1 ? ' err' : '');
      }
    };
  }

  var LS_PUSH_WANTED = 'pcsport.pushWanted';

  function pushWanted() {
    try { return localStorage.getItem(LS_PUSH_WANTED) === '1'; } catch (e) { return false; }
  }
  function setPushWanted(on) {
    try { localStorage.setItem(LS_PUSH_WANTED, on ? '1' : '0'); } catch (e) {}
  }

  function renderNotifyButtons(state) {
    var bell = $('#bell-btn');
    var cfgBtn = $('#cfg-notify');
    var on = state === 'on';
    if (bell) {
      bell.textContent = on ? '🔔' : '🔕';
      bell.classList.toggle('off', !on);
      bell.title = on ? 'Уведомления включены — выключить' : 'Уведомления выключены — включить';
    }
    if (cfgBtn) {
      cfgBtn.textContent = on ? 'Выключить уведомления' : 'Включить уведомления о новых сообщениях';
      cfgBtn.classList.toggle('ghost', on);
    }
  }

  /* Тихая сверка: человек уведомления включал, разрешение в браузере
     есть — а живой подписки нет. Молча оформляем заново, ничего не
     спрашивая: для человека «включил — значит работает», а не «включил,
     потом само отвалилось». */
  function ensurePushSubscription() {
    if (!pushWanted() || !myId()) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!Storage.webpush.supported()) return;

    Storage.webpush.isSubscribed().then(function (has) {
      if (has) {
        /* Подписка на месте — но у сервера её могло не остаться
           (например, чистка протухших записей задела лишнее). Отправляем
           повторно: на бэкенде это идемпотентно по endpoint, дубля не
           создаст. */
        return Storage.webpush.subscribe(myId()).then(function () {
          renderNotifyButtons('on');
        });
      }
      PCLog.warn('Push-подписка пропала — восстанавливаю молча');
      return Storage.webpush.subscribe(myId()).then(function () {
        PCLog.info('Push-подписка восстановлена автоматически');
        renderNotifyButtons('on');
      });
    }).catch(function (e) {
      PCLog.warn('Не удалось сверить push-подписку: ' + e.message);
    });
  }

  /* Общий обработчик для обеих кнопок — колокольчика и настроек. */
  function toggleNotifications(statusEl) {
    function say(text, cls) {
      if (statusEl) { statusEl.textContent = text; statusEl.className = 'status-line' + (cls ? ' ' + cls : ''); }
    }

    if (!('Notification' in window)) { say('Браузер не поддерживает уведомления', 'err'); return; }
    if (!myId()) { say('Сначала выбери, кто ты', 'err'); return; }

    // Выключение — если человек уже подписан
    if (pushWanted()) {
      say('Выключаю…');
      setPushWanted(false);
      Storage.webpush.unsubscribe(myId()).then(function () {
        say('Уведомления выключены', 'ok');
        PCLog.info('Push-подписка отключена вручную');
        renderNotifyButtons('off');
      }).catch(function (e) {
        /* Даже если отписаться на сервере не вышло — локальный флаг уже
           снят, и ensurePushSubscription() больше не будет её
           восстанавливать. Для человека выключено, а остаточная запись
           на сервере отвалится сама при первой же неудачной отправке. */
        say('Выключено (сервер ответил ошибкой: ' + e.message + ')', 'err');
        renderNotifyButtons('off');
      });
      return;
    }

    // Включение
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') {
        say('Не разрешено в браузере', 'err');
        PCLog.warn('Уведомления не разрешены: ' + perm);
        return;
      }
      if (!Storage.webpush.supported()) {
        say('Разрешение получено, но push не поддерживается — на iPhone работает только для версии, добавленной на «Экран Домой»', 'err');
        return;
      }
      say('Оформляю подписку…');
      Storage.webpush.subscribe(myId()).then(function () {
        setPushWanted(true);
        say('Включено — прилетит, даже если приложение полностью закрыто', 'ok');
        PCLog.info('Push-подписка оформлена для ' + myId());
        renderNotifyButtons('on');
      }).catch(function (e) {
        say('Не получилось подписаться: ' + e.message, 'err');
        PCLog.error('Push-подписка не удалась: ' + e.message);
      });
    });
  }

  function render() {
    renderWhoBtn();
    renderToday();
    renderLog();
    renderMoney();
    renderCfg();
    renderChat();
    renderNotifyButtons(pushWanted() ? 'on' : 'off');
  }

  /* Видна ли сейчас вкладка «Чат» — для service worker (см. sw.js,
     обработчик 'push'). SW не имеет доступа к переменным страницы, но
     видит client.url, поэтому признак живёт в адресе. */
  function markChatOpenInUrl(isOpen) {
    try {
      var base = location.pathname + location.search;
      history.replaceState(null, '', isOpen ? base + '#chat-open' : base);
    } catch (e) { /* history может быть недоступна — не критично, push просто будет приходить как раньше */ }
  }

  function show(view) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('on'); });
    $('#v-' + view).classList.add('on');
    document.querySelectorAll('[data-view]').forEach(function (b) {
      b.classList.toggle('on', b.dataset.view === view);
    });
    window.scrollTo(0, 0);

    /* Верхняя навигация вместо нижних вкладок: на "Сегодня" — группа
       кнопок (Журнал/Чат/Настройки), везде ещё — одна "← Назад" на
       тот же "Сегодня". Один и тот же элемент во всех "не домашних"
       экранах, как и просили. */
    var isHome = view === 'today';
    $('#topnav-home-actions').hidden = !isHome;
    $('#topnav-back').hidden = isHome;

    /* Пока открыт чат, скроллится только сам #v-chat, а не страница
       целиком (см. body.chat-open в styles.css) — иначе под чатом
       оставалась оттягиваемая "губа" из фона body. */
    document.body.classList.toggle('chat-open', view === 'chat');

    /* Метка в адресе — единственное, что service worker может увидеть
       снаружи (ему доступен только client.url, до переменных страницы
       он не дотянется). По ней SW решает, показывать ли push: если чат
       открыт и окно видимое — уведомление не показывается, человек и
       так видит сообщение мгновенно. replaceState, а не hash = ... —
       чтобы не плодить записи в истории и не ловить лишний hashchange. */
    markChatOpenInUrl(view === 'chat');

    if (view === 'chat') {
      chatStickToBottom = true; // открытие — всегда считаем, что едем в самый низ
      syncHeaderHeightVar();
      syncChatHeight(); // высота колонки — до того, как считать "низ" ленты
      prepareUnreadSnapshot();
      markChatRead();
      renderChat();
      scrollChatToBottom();
      updateScrollBottomBtn();
    } else {
      var scrollBtn = $('#scroll-bottom-btn');
      if (scrollBtn) scrollBtn.hidden = true;
      unreadSnapshot = null; // при следующем открытии посчитается заново
    }
    /* Опрос чата и реальное время теперь НЕ привязаны к тому, открыта
       ли именно вкладка "Чат" — работают всё время, пока выбрана
       идентичность, чтобы бейдж непрочитанных обновлялся, даже когда
       сидишь на "Сегодня" или в Настройках (см. также запуск в boot()
       и commitIdentity()). show() их больше не запускает/останавливает. */
  }

  /* Отдельная функция, а не часть renderChat(): нужно гарантированно
     долистать в самый низ именно в момент ОТКРЫТИЯ вкладки, а не
     полагаться на эвристику "прокрутка уже была внизу" — при первом
     показе вкладки контейнер только что стал видимым, и его текущие
     scrollHeight/scrollTop ещё не отражают реальную раскладку. Двойной
     rAF — layout успевает посчитаться перед тем, как прокручиваем. */
  function scrollChatToBottom() {
    /* #v-chat теперь сам себе скроллящийся контейнер с ЗАДАННОЙ высотой
       (position:fixed, top/bottom — см. styles.css) — el.scrollTop =
       el.scrollHeight детерминирован сам по себе. Двойной rAF всё равно
       не лишний: сама разметка (layout) под только что вставленный
       innerHTML применяется не мгновенно в момент присваивания, а к
       следующему кадру отрисовки. */
    var el = document.getElementById('chat-log');
    if (!el) return;
    function toBottom() { el.scrollTop = el.scrollHeight; }
    requestAnimationFrame(function () {
      requestAnimationFrame(toBottom);
    });
    /* Запасной проход — если в новых сообщениях есть аватары/превью, их
       размеры (а значит и итоговая высота ленты) могут доуточниться уже
       ПОСЛЕ кадра отрисовки (декодирование картинки, довычисление
       шрифта). Без этого низ иногда оказывался чуть выше настоящего. */
    setTimeout(toBottom, 250);
  }

  /* Кнопка "вниз" (как в Telegram) — всплывает, когда пролистал ленту
     чата вверх дальше чем на экран, и пропадает у самого низа. Скролл —
     внутри самого #v-chat (см. styles.css), не всей страницы. */
  var SCROLL_BOTTOM_THRESHOLD = 200;
  function updateScrollBottomBtn() {
    var btn = document.getElementById('scroll-bottom-btn');
    var el = document.getElementById('chat-log');
    if (!btn || !el) return;
    if (!document.getElementById('v-chat').classList.contains('on')) { btn.hidden = true; return; }
    var distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    btn.hidden = distance < SCROLL_BOTTOM_THRESHOLD;
    chatStickToBottom = distance < SCROLL_BOTTOM_THRESHOLD;
  }

  /* Поле ввода больше НИЧЕМ не двигается вручную — оно просто нижняя
     строка flex-колонки чата (см. .chat-bottom в styles.css). Осталась
     одна задача: задать колонке высоту ровно до низа ВИДИМОЙ области.

     Считаем от собственного getBoundingClientRect().top самого чата, а
     не от измеренной высоты шапки — так значение самокорректирующееся:
     подхватывает любую реальную высоту шапки (она меняется, когда
     догружаются шрифты) без отдельного замера, который может протухнуть.

     visualViewport.height вместо innerHeight — потому что на iOS
     клавиатура перекрывает низ экрана, не меняя раскладочный вьюпорт.
     Ужимаем колонку — и поле ввода само встаёт над клавиатурой, без
     единого подобранного вручную отступа. */
  function syncChatHeight() {
    var chatEl = document.getElementById('v-chat');
    if (!chatEl || !chatEl.classList.contains('on')) return;
    var top = chatEl.getBoundingClientRect().top;
    var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    var h = Math.max(200, Math.round(vh - top));
    if (chatEl.style.height !== h + 'px') chatEl.style.height = h + 'px';
    if (chatStickToBottom) {
      var log = document.getElementById('chat-log');
      if (log) log.scrollTop = log.scrollHeight;
    }
  }

  function initChatKeyboardOffset() {
    if (!window.visualViewport) return;
    window.visualViewport.addEventListener('resize', syncChatHeight);
    window.visualViewport.addEventListener('scroll', syncChatHeight);
    syncChatHeight();
  }

  function bind() {
    document.querySelectorAll('[data-view]').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.view); });
    });

    $('#chat-log').addEventListener('scroll', updateScrollBottomBtn, { passive: true });
    $('#scroll-bottom-btn').addEventListener('click', function () {
      scrollChatToBottom();
      markChatRead();
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
      if (!text.trim()) return;
      inp.value = '';
      /* Раньше здесь был флаг chatSending, блокировавший форму целиком
         до завершения сетевого запроса предыдущего сообщения — то есть
         набрать и отправить второе сообщение было физически нельзя,
         пока первое висело в "отправка…". У каждой отправки уже свой
         независимый tempId (см. sendChatMessage) — несколько сообщений
         одновременно "в полёте" отслеживаются корректно и без этого
         флага, как в любом нормальном мессенджере. */
      sendChatMessage(text);
    });

    $('#chat-select-cancel').addEventListener('click', exitSelectMode);
    $('#chat-select-copy').addEventListener('click', copySelectedMessages);
    $('#chat-select-delete').addEventListener('click', deleteSelectedMessages);

    $('#readby-close').addEventListener('click', function () { $('#readByOverlay').classList.remove('on'); });

    /* Скрепка — тот же паттерн, что и меню сообщения: тап открывает
       маленькое всплывающее меню с двумя пунктами (по референсу
       Telegram Web, без «Список» — не нужен для этого приложения),
       выбор пункта открывает системный выбор файла нужного типа. */
    $('#chat-attach-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      var menu = $('#attach-menu');
      if (!menu.hidden) { menu.hidden = true; return; }
      menu.hidden = false;
      var closeOnce = function (ev) {
        if (!menu.contains(ev.target) && ev.target !== $('#chat-attach-btn')) {
          menu.hidden = true;
          document.removeEventListener('click', closeOnce);
        }
      };
      setTimeout(function () { document.addEventListener('click', closeOnce); }, 0);
    });
    $('#chat-emoji-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      closeMentionMenu();
      var wasHidden = $('#emoji-picker').hidden;
      toggleEmojiPicker();
      if (wasHidden) {
        var panel = $('#emoji-picker');
        var closeOnce = function (ev) {
          if (!panel.contains(ev.target) && ev.target !== $('#chat-emoji-btn')) {
            closeEmojiPicker();
            document.removeEventListener('click', closeOnce);
          }
        };
        setTimeout(function () { document.addEventListener('click', closeOnce); }, 0);
      }
    });

    $('#attach-menu [data-attach="media"]').addEventListener('click', function () {
      $('#attach-menu').hidden = true;
      $('#attach-input-media').click();
    });
    $('#attach-menu [data-attach="file"]').addEventListener('click', function () {
      $('#attach-menu').hidden = true;
      $('#attach-input-file').click();
    });
    $('#attach-input-media').addEventListener('change', function () {
      var file = this.files[0];
      this.value = '';
      if (!file) return;
      var type = file.type && file.type.indexOf('image/') === 0 ? 'image' : 'file';
      sendChatAttachment(file, type);
    });
    $('#attach-input-file').addEventListener('change', function () {
      var file = this.files[0];
      this.value = '';
      if (!file) return;
      sendChatAttachment(file, 'file');
    });

    var chatTextEl = $('#chat-text');
    chatTextEl.addEventListener('input', updateMentionMenu);
    chatTextEl.addEventListener('click', updateMentionMenu);
    chatTextEl.addEventListener('blur', function () {
      // клик по самому пункту меню должен успеть отработать раньше скрытия
      setTimeout(closeMentionMenu, 150);
    });
    chatTextEl.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMentionMenu();
    });

    $('#cfg-notify').addEventListener('click', function () {
      toggleNotifications($('#cfg-notify-status'));
    });

    /* Колокольчик на «Сегодня» — тот же переключатель, что и в
       настройках, просто под рукой. Статус показываем коротким
       всплывающим сообщением, отдельной строки статуса на главной нет. */
    var bell = $('#bell-btn');
    if (bell) {
      bell.addEventListener('click', function () { toggleNotifications(toastStatus()); });
    }

    $('#health-check-run').addEventListener('click', runHealthCheck);
    $('#health-check-copy').addEventListener('click', function () {
      copyTextTo(healthCheckLastText || '(лог ещё не собирался)', $('#health-check-status'));
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

    $('#cfg-papich').addEventListener('change', function () {
      localStorage.setItem(PAPICH_KEY, this.checked ? '1' : '0');
      applyPapichMode(); // фон в чате — сразу; заставка — только со следующего открытия приложения
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
  /* Реальная высота закреплённой шапки (--header-h) — от неё #v-chat
     (см. styles.css) отсчитывает свой top, чтобы быть скроллящимся
     контейнером РОВНО от низа шапки до низа экрана, без зазоров и без
     наезда. Раньше это было магическое число 230px в CSS, подобранное
     на глаз под шапку БЕЗ верхней навигации — как только навигацию
     добавили, число разошлось с реальностью, и вся геометрия чата
     поехала (отсюда и "пузырь висит где-то посередине"). Меряем
     реальный DOM вместо того, чтобы гадать. */
  function syncHeaderHeightVar() {
    var header = document.getElementById('header-sticky');
    if (!header) return;
    document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  }

  /* ============================================================
     "Режим Папич" — заставка на 2 сек при открытии + фон в чате,
     общий выключатель на весь этот прикол. По умолчанию включён (сам
     факт, что localStorage пуст, ещё не значит "выключено"). Значение
     хранится локально на телефоне — как и идентичность, не общее на
     всех участников. Ключ и значения ('1'/'0') совпадают с инлайн-
     скриптом в index.html, который прячет заставку ДО загрузки этого
     файла — если поменять здесь, поменять и там. */
  var PAPICH_KEY = 'pcsport_papich';
  function papichEnabled() {
    var v = localStorage.getItem(PAPICH_KEY);
    return v !== '0';
  }
  function applyPapichMode() {
    document.body.classList.toggle('papich-off', !papichEnabled());
  }

  function hideSplash() {
    var el = document.getElementById('splash-screen');
    if (!el) return;
    el.classList.add('hide');
    setTimeout(function () { el.remove(); }, 400);
  }

  function boot() {
    state = normalize(Storage.readLocal());
    chatMessages = Storage.chat.readCache();
    cursor = today();
    applyPapichMode();
    if (papichEnabled()) setTimeout(hideSplash, 2000);
    // если выключено — заставку уже убрал инлайн-скрипт в index.html,
    // до этого места мы вообще не доходим с ней в DOM
    bind();
    render();
    syncHeaderHeightVar();
    /* Шрифты (Unbounded/IBM Plex) могут доподгрузиться уже после
       первого замера и на пиксель-два изменить высоту шапки — один
       отложенный повторный замер подчищает такую погрешность. */
    setTimeout(syncHeaderHeightVar, 400);
    window.addEventListener('resize', syncHeaderHeightVar);
    window.addEventListener('orientationchange', function () { setTimeout(syncHeaderHeightVar, 200); });
    initChatKeyboardOffset();
    tick();
    setInterval(tick, 1000);

    if (!myId()) openIdentityGate();
    else startGlobalChatSync();

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

      /* Service worker спрашивает перед показом push: «чат сейчас
         открыт?». Отвечаем честно — по реальному состоянию вкладки, а
         не по метке в адресе (см. пояснение в sw.js: на iOS client.url
         в SW после replaceState остаётся прежним, и push прилетал
         человеку, который в этот момент смотрел прямо в чат). */
      navigator.serviceWorker.addEventListener('message', function (e) {
        if (!e.data || e.data.type !== 'pcsport-is-chat-open') return;
        var chatView = document.getElementById('v-chat');
        var open = !!(chatView && chatView.classList.contains('on')) &&
                   document.visibilityState === 'visible';
        if (e.ports && e.ports[0]) e.ports[0].postMessage({ chatOpen: open });
      });
    }

    /* Подписка на push может «протухнуть» сама по себе — браузер вправе
       её отозвать (переустановка PWA, чистка данных, ротация ключей на
       стороне push-службы). Для человека это выглядит как «включал же —
       а не приходят». Поэтому при каждом запуске и возврате в
       приложение тихо сверяем: если человек уведомления включал, а
       живой подписки в браузере уже нет — оформляем заново, молча. */
    ensurePushSubscription();
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) ensurePushSubscription();
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
