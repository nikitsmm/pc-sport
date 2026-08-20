/* ============================================================
   storage.js — слой хранения «ПЦ Спорт»

   Архитектура один в один с Herald Chat: клиент НИЧЕГО не знает
   про Яндекс.Диск и токены. Всё, что у него есть, — это URL одной
   облачной функции (Yandex Cloud Function) и один вызов:

       api(action, params) → POST {action, ...params} → JSON

   Сама функция (бэкенд, вне этого приложения — см. backend/index.py)
   уже сама лезет в Яндекс.Диск своим токеном, который лежит в
   переменных окружения функции и в браузер никогда не попадает.

   Ожидаемые действия бэкенда:
     get_state  ()               → { state: {...} | null }
     save_state ({ state })      → { ok: true }
     ping       ()                → { ok: true }
     send_message ({ participantId, text })  → { ok: true, message }
     get_messages ({ since? })               → { items: [...] }

   Если схема действий в реальном бэкенде Herald Chat отличается —
   меняются только имена action и форма params/ответа ниже,
   остальной код приложения (app.js) их не касается.
   ============================================================ */

(function (global) {
  'use strict';

  var LS_STATE = 'pcsport.state';
  var LS_CFG = 'pcsport.config';
  var LS_MYID = 'pcsport.myId';
  var LS_MYID_EVER = 'pcsport.myIdEverSet';
  var LS_CHAT_CACHE = 'pcsport.chatCache';

  /* ---------- безопасный localStorage (не падаем в песочницах) ---------- */
  var mem = {};
  var LS = {
    get: function (k) {
      try { return global.localStorage.getItem(k); } catch (e) { return mem[k] || null; }
    },
    set: function (k, v) {
      try { global.localStorage.setItem(k, v); } catch (e) { mem[k] = v; }
    },
    del: function (k) {
      try { global.localStorage.removeItem(k); } catch (e) { delete mem[k]; }
    }
  };

  /* ---------- конфиг синхронизации ----------
     Хранится только URL облачной функции — ни токенов, ни путей.
     backend: 'local' — только на этом устройстве
              'cloud' — общее состояние через функцию на Яндекс.Облаке */
  var Config = {
    read: function () {
      var raw = LS.get(LS_CFG);
      var cfg = { backend: 'local', url: '' };
      if (raw) { try { Object.assign(cfg, JSON.parse(raw)); } catch (e) {} }
      return cfg;
    },
    write: function (cfg) { LS.set(LS_CFG, JSON.stringify(cfg)); }
  };

  /* ============================================================
     Вызов облачной функции — тот же контракт, что в Herald Chat:
     POST { action, ...params } → JSON. Никаких заголовков авторизации,
     функция сама решает, кому доверять (см. backend/index.py).
     ============================================================ */
  async function api(url, action, params) {
    if (!url) throw new Error('Не задан URL облачной функции');
    var res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: action }, params || {}))
      });
    } catch (netErr) {
      if (global.PCLog) PCLog.error('api(' + action + '): сеть — ' + netErr.message);
      throw new Error('Нет связи с функцией: ' + netErr.message);
    }
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || data.error) {
      var msg = data.error_description || data.error || ('HTTP ' + res.status);
      if (global.PCLog) PCLog.error('api(' + action + '): ' + msg);
      throw new Error(msg);
    }
    return data;
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Часы конкретного телефона отвечают за updatedAt/at при слиянии
     состояния (см. merge() ниже) — если они убежали вперёд или сильно
     отстали, это реальный источник багов (уже был случай, когда
     устаревшая/будущая копия с одного телефона чуть не затёрла чужие
     отметки при синхронизации). Сверяем при каждом обращении к серверу
     и громко предупреждаем, если расхождение больше 3 минут — раньше,
     чем это успеет что-то испортить, а не постфактум. Не чаще раза в
     10 минут, чтобы не долбить логи на каждый чих. */
  var lastSkewWarnAt = 0;
  function checkClockSkew(serverTimeIso) {
    if (!serverTimeIso || !global.PCLog) return;
    var serverMs = Date.parse(serverTimeIso);
    if (!serverMs) return;
    var driftMs = Date.now() - serverMs;
    var driftMin = Math.round(driftMs / 60000);
    if (Math.abs(driftMin) >= 3 && Date.now() - lastSkewWarnAt > 10 * 60000) {
      lastSkewWarnAt = Date.now();
      PCLog.warn('Часы на этом телефоне расходятся с сервером на ' + driftMin + ' мин — проверь дату/время в настройках телефона, иначе синхронизация может повести себя странно.');
    }
  }

  /* Файл на Диск уже уехал к этому моменту — если сама запись в общий
     индекс (confirm_upload) споткнётся о кратковременный сбой сети,
     видео физически есть, но в приложении не появится. Несколько
     попыток с паузой закрывают почти все такие случаи. */
  async function apiRetry(url, action, params, attempts) {
    var lastErr;
    for (var i = 0; i < attempts; i++) {
      try { return await api(url, action, params); }
      catch (e) { lastErr = e; if (i < attempts - 1) await wait(800 * (i + 1)); }
    }
    throw lastErr;
  }

  /* ============================================================
     Надёжная очередь загрузки видео (IndexedDB).

     Цель — то же самое, что у Telegram/WhatsApp: если сеть оборвалась
     посреди отправки, запись не теряется и не требует новой съёмки.
     Blob кладётся в IndexedDB ДО первой попытки заливки и удаляется
     оттуда только после подтверждённого успеха — переживает даже
     полное закрытие вкладки/приложения, не только временный сбой сети.
     ============================================================ */
  var DB_NAME = 'pcsport';
  var DB_STORE = 'pendingVideos';

  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) { reject(new Error('IndexedDB недоступен')); return; }
      var req = global.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE, { keyPath: 'id' }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbPut(record) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(record);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbDelete(id) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbGetAll() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readonly');
        var req = tx.objectStore(DB_STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  /* Один PUT-запрос, вынесен отдельно, чтобы вызывать его в цикле повторов. */
  function putOnce(uploadUrl, contentType, blob, onProgress, onPhase) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl, true);
      if (contentType) xhr.setRequestHeader('Content-Type', contentType);
      xhr.upload.onprogress = function (e) {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
        if (e.lengthComputable && e.loaded >= e.total && onPhase) onPhase('Файл отправлен, жду подтверждения…');
      };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('Не удалось загрузить видео (HTTP ' + xhr.status + ')'));
      };
      xhr.onerror = function () { reject(new Error('Сеть прервалась во время загрузки видео')); };
      xhr.send(blob);
    });
  }

  /* ---------- кто пишет с этого устройства ----------
     Своего логина в приложении нет (тот же принцип, что и у отметок
     дня, и у видео) — просто локальный выбор на телефоне, никуда не
     синхронизируется, у каждого свой. По требованию — закрепляется:
     обычным способом в интерфейсе её не поменять, только через явный
     сброс в настройках. everSet НЕ сбрасывается вместе с самой
     идентичностью — так можно отличить самый первый выбор на этом
     телефоне от повторного (после сброса), чтобы во втором случае
     сообщение в чат звучало тревожнее. */
  var Identity = {
    read: function () { return LS.get(LS_MYID) || ''; },
    write: function (id) { LS.set(LS_MYID, id || ''); },
    everSet: function () { return LS.get(LS_MYID_EVER) === '1'; },
    markEverSet: function () { LS.set(LS_MYID_EVER, '1'); },
    reset: function () { LS.del(LS_MYID); } // LS_MYID_EVER остаётся — это и есть смысл
  };

  /* ============================================================
     Публичный интерфейс — сигнатуры прежние, чтобы app.js не менять
     ============================================================ */
  var Storage = {
    config: Config,
    identity: Identity,

    /* Локальная копия — читается мгновенно при старте. */
    readLocal: function () {
      var raw = LS.get(LS_STATE);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    },

    writeLocal: function (state) { LS.set(LS_STATE, JSON.stringify(state)); },

    /* Проверка связи с функцией — используется в настройках. */
    check: async function (cfg) {
      cfg = cfg || Config.read();
      var r = await api(cfg.url, 'ping', {});
      checkClockSkew(r && r.serverTime);
      return r;
    },

    /* Забрать состояние из облака. Возвращает состояние или null. */
    pull: async function () {
      var cfg = Config.read();
      if (cfg.backend !== 'cloud' || !cfg.url) return null;
      var data = await api(cfg.url, 'get_state', {});
      checkClockSkew(data && data.serverTime);
      var remote = data && data.state ? data.state : null;
      if (remote) this.writeLocal(remote);
      return remote;
    },

    /* Отправить состояние в облако. Тихо выходит, если облако не настроено. */
    push: async function (state) {
      this.writeLocal(state);
      var cfg = Config.read();
      if (cfg.backend !== 'cloud' || !cfg.url) return { synced: false };
      await api(cfg.url, 'save_state', { state: state });
      return { synced: true, at: new Date().toISOString() };
    },

    /* Слияние: побеждает более свежий updatedAt.
       Для четырёх человек этого достаточно, разрешение конфликтов
       по отдельным дням не городим. */
    /* Раньше здесь было "весь объект целиком, у кого updatedAt новее" —
       и это оказалось по-настоящему опасно: updatedAt берётся из часов
       конкретного телефона (new Date() на клиенте), а не с сервера.
       Если на одном телефоне часы отстали/убежали вперёд, или на нём
       просто долго не открывали приложение и там лежит старая
       локальная копия — при следующей синхронизации эта старая копия
       может "победить" свежие данные с чужих телефонов ЦЕЛИКОМ, а
       потом при первом же собственном изменении на этом телефоне
       затереть общее состояние на сервере — включая чужие отметки,
       которые этот телефон вообще не трогал. Ровно так один раз и
       произошло: устаревшая копия победила при слиянии, отметки
       Антона/Артура/Коли пропали ещё на этапе открытия приложения, а
       после того как на этом же телефоне поставили галочку себе —
       эта версия (без чужих отметок) улетела на сервер и затёрла всё.

       Починено: days сливаются по ОТДЕЛЬНОЙ ЗАПИСИ (дата+участник), не
       по всему объекту разом. Даже если на одном телефоне часы совсем
       не те — он может задеть максимум те ячейки, которые сам же и
       редактировал, а не всё состояние целиком. Конфликт на ОДНОЙ и той
       же ячейке (редкость — два человека одновременно поменяли статус
       одного и того же человека в один день) решается по времени самой
       записи (её собственное поле "at"), не по updatedAt всего объекта. */
    merge: function (localState, remoteState) {
      if (!remoteState) return localState;
      if (!localState) return remoteState;

      var merged = JSON.parse(JSON.stringify(remoteState));
      merged.days = {};

      var dates = {};
      Object.keys(localState.days || {}).forEach(function (d) { dates[d] = true; });
      Object.keys(remoteState.days || {}).forEach(function (d) { dates[d] = true; });

      Object.keys(dates).forEach(function (date) {
        var l = (localState.days || {})[date] || {};
        var r = (remoteState.days || {})[date] || {};
        var pids = {};
        Object.keys(l).forEach(function (id) { pids[id] = true; });
        Object.keys(r).forEach(function (id) { pids[id] = true; });

        var dayMerged = {};
        Object.keys(pids).forEach(function (pid) {
          var lRec = l[pid], rRec = r[pid];
          if (lRec && rRec) {
            var lt = Date.parse(lRec.at || 0) || 0;
            var rt = Date.parse(rRec.at || 0) || 0;
            dayMerged[pid] = lt >= rt ? lRec : rRec;
          } else {
            dayMerged[pid] = lRec || rRec;
          }
        });
        if (Object.keys(dayMerged).length) merged.days[date] = dayMerged;
      });

      /* Список участников/норм и общие настройки (штраф, лимит альтернатив
         и т.п.) меняются редко и почти никогда параллельно с чужого
         телефона — для них пока оставлена более простая логика "берём
         версию с телефона, где updatedAt свежее", риск ниже на порядок,
         чем у days, где правки идут каждый день с четырёх телефонов
         одновременно. */
      var l = Date.parse(localState.updatedAt || 0) || 0;
      var r = Date.parse(remoteState.updatedAt || 0) || 0;
      if (l > r) {
        merged.participants = localState.participants;
        merged.anchor = localState.anchor;
        merged.fine = localState.fine;
        merged.altLimit = localState.altLimit;
        merged.maxMult = localState.maxMult;
        merged.deadline = localState.deadline;
      }

      merged.updatedAt = new Date().toISOString();
      return merged;
    },

    reset: function () { LS.del(LS_STATE); },

    /* ============================================================
       Видео — Yandex Object Storage (S3-совместимое), не Диск.

       Раньше здесь было ветвление «маленький файл — через саму функцию,
       большой — через капризную временную ссылку Диска». С переездом
       видео на Object Storage ветвление не нужно: presigned-ссылки
       нормально поддерживают Range для <video> и не ограничены размером
       файла — один и тот же путь работает для 5-секундного и
       минутного ролика.

       Загрузка ниже дополнительно проходит через IndexedDB-очередь —
       см. helpers idbOpen/idbPut/idbDelete/idbGetAll/putOnce выше по
       файлу — если сеть оборвалась посреди отправки, blob не теряется
       и не требует новой съёмки, переживает даже закрытие приложения.
       ============================================================ */
    video: {
      supported: function () {
        var cfg = Config.read();
        return cfg.backend === 'cloud' && !!cfg.url;
      },

      /* onProgress(fraction 0..1) — по ходу отправки байт.
         onPhase(text) — смена фазы (отправка → повтор при сбое сети →
         ждём ответ сервера → записываем в индекс).

         meta — необязательные { reps, thumb }.

         Возвращает { confirmed: bool }. Сам PUT теперь повторяется до
         3 раз при сетевом сбое, прежде чем считаться настоящей ошибкой
         (throw) — «сеть прервалась» на мобильной сети сплошь и рядом
         означает «попробуй ещё раз», а не «файл потерян». Blob лежит в
         IndexedDB с самого начала попытки — если и три повтора не
         помогут, запись останется в очереди и её можно будет дозалить
         из pending()/resumePending() позже, даже после закрытия
         приложения, без новой съёмки.

         Если сам PUT прошёл, а confirm_upload после трёх попыток так и
         не подтвердился — это НЕ потеря: файл уже физически в бакете,
         запись о нём в общий список подтянется сама при следующем
         открытии «Видео дня» (list_videos сверяется с бакетом). */
      upload: async function (participantId, date, blob, ext, onProgress, onPhase, meta) {
        meta = meta || {};
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) {
          throw new Error('Видео можно отправлять только при включённой облачной синхронизации');
        }

        var pendingId = meta.pendingId || ('pv-' + Date.now() + '-' + Math.random().toString(36).slice(2));
        try {
          await idbPut({
            id: pendingId, participantId: participantId, date: date, ext: ext, blob: blob,
            reps: meta.reps || null, thumb: meta.thumb || null, createdAt: Date.now()
          });
        } catch (e) { /* IndexedDB недоступен — грузим без страховки на закрытие приложения */ }

        var upMeta = await api(cfg.url, 'get_upload_url', { participantId: participantId, date: date, ext: ext });

        var attempts = 3, lastErr = null;
        for (var i = 0; i < attempts; i++) {
          try {
            await putOnce(upMeta.uploadUrl, upMeta.contentType, blob, onProgress, onPhase);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (i < attempts - 1) {
              if (onPhase) onPhase('Сеть подвела — пробую снова (' + (i + 2) + '/' + attempts + ')…');
              await wait(2000 * (i + 1));
            }
          }
        }
        if (lastErr) throw lastErr; // запись остаётся в IndexedDB — можно дозалить позже

        if (onPhase) onPhase('Записываю в общий список видео…');
        var confirmed = true;
        try {
          await apiRetry(cfg.url, 'confirm_upload', {
            participantId: participantId, date: date, videoId: upMeta.videoId, path: upMeta.path, ext: ext,
            size: blob.size, reps: meta.reps || null, thumb: meta.thumb || null
          }, 3);
        } catch (e) { confirmed = false; }

        try { await idbDelete(pendingId); } catch (e) {}
        return { confirmed: confirmed, path: upMeta.path, videoId: upMeta.videoId };
      },

      /* Список ещё не отправленных роликов — например, после того как
         приложение закрыли посреди обрыва сети. */
      pending: function () { return idbGetAll().catch(function () { return []; }); },

      /* Убрать из очереди без отправки — например, если решили
         пересобрать заново, не досылать старую попытку. */
      dropPending: function (id) { return idbDelete(id).catch(function () {}); },

      list: async function () {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) return { items: [], retentionDays: 0 };
        return api(cfg.url, 'list_videos', {});
      },

      /* Полная сверка индекса со всем содержимым бакета, без ограничения
         окном хранения — для кнопки в настройках, когда хочется
         убедиться прямо сейчас, что ничего не потерялось. */
      sync: async function () {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) throw new Error('Облако не настроено');
        return api(cfg.url, 'sync_videos', {});
      },

      /* Ручной запуск того же действия, что обычно дёргает Timer-триггер
         раз в сутки — чтобы можно было своими глазами убедиться, что
         старые видео реально удаляются, а не просто верить на слово. */
      cleanupNow: async function () {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) throw new Error('Облако не настроено');
        return apiRetry(cfg.url, 'cleanup_old', {}, 3);
      },

      /* Возвращает { url }. Presigned-ссылка Object Storage — можно
         сразу отдавать в <video src>, Range поддерживается штатно. */
      playUrl: async function (path) {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) throw new Error('Облако не настроено');
        var d = await api(cfg.url, 'get_download_url', { path: path });
        return { url: d.url };
      },

      deleteVideo: async function (path, videoId) {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) throw new Error('Облако не настроено');
        return apiRetry(cfg.url, 'delete_video', { path: path, videoId: videoId }, 3);
      }
    },

    /* ============================================================
       Push-уведомления (Web Push) — приходят даже когда приложение
       полностью закрыто, не только пока браузер жив в фоне. На iPhone
       работает ТОЛЬКО для приложения, установленного через «Добавить
       на экран Домой» — обычная вкладка Safari push не получит никогда,
       это ограничение самого iOS.

       Публичный VAPID-ключ — не секрет, ровно поэтому он в коде клиента:
       им нельзя ничего подписать, только браузер использует его, чтобы
       зашифровать подписку так, что расшифровать её сможет только
       владелец приватного ключа (наш бэкенд). Приватный ключ живёт
       только в переменных окружения функции.
       ============================================================ */
    push: {
      VAPID_PUBLIC_KEY: 'BAWcHG-8IwPG9yILkKHxmYxwF3rycwtLMHcU_7gkAQ2y5rPFzsMyPeQac3RM2QPRAEuH-r6d2xLYnFbkTkDCsvU',

      supported: function () {
        return !!(global.navigator && 'serviceWorker' in navigator && 'PushManager' in global);
      },

      _urlBase64ToUint8Array: function (base64String) {
        var padding = '='.repeat((4 - base64String.length % 4) % 4);
        var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        var raw = atob(base64);
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
      },

      /* Оформляет подписку браузера (если её ещё нет) и отправляет её
         бэкенду, привязанную к конкретному участнику — чтобы функция
         знала, кому именно слать push при новом сообщении. */
      subscribe: async function (participantId) {
        if (!this.supported()) throw new Error('Push-уведомления не поддерживаются этим браузером');
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) throw new Error('Облако не настроено');

        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (!sub) {
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: this._urlBase64ToUint8Array(this.VAPID_PUBLIC_KEY)
          });
        }
        await api(cfg.url, 'save_push_subscription', { participantId: participantId, subscription: sub.toJSON() });
        return true;
      },

      unsubscribe: async function (participantId) {
        if (!this.supported()) return;
        var cfg = Config.read();
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        if (sub) {
          var endpoint = sub.endpoint;
          await sub.unsubscribe();
          if (cfg.backend === 'cloud' && cfg.url) {
            await api(cfg.url, 'remove_push_subscription', { participantId: participantId, endpoint: endpoint }).catch(function () {});
          }
        }
      },

      isSubscribed: async function () {
        if (!this.supported()) return false;
        var reg = await navigator.serviceWorker.ready;
        var sub = await reg.pushManager.getSubscription();
        return !!sub;
      }
    },

    /* ============================================================
       Чат — общий файл на Диске, тот же принцип, что и у видео-индекса.
       Локальный кэш даёт мгновенный список при открытии вкладки, пока
       свежие сообщения подтягиваются в фоне.
       ============================================================ */
    chat: {
      readCache: function () {
        var raw = LS.get(LS_CHAT_CACHE);
        if (!raw) return [];
        try { return JSON.parse(raw); } catch (e) { return []; }
      },
      writeCache: function (items) { LS.set(LS_CHAT_CACHE, JSON.stringify(items)); },

      /* since — id последнего уже известного сообщения, чтобы не
         перекачивать всю историю на каждый опрос. */
      fetch: async function (since) {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) return { items: [] };
        return api(cfg.url, 'get_messages', since ? { since: since } : {});
      },

      send: async function (participantId, text, replyTo) {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) {
          throw new Error('Чат работает только при включённой облачной синхронизации');
        }
        var r = await apiRetry(cfg.url, 'send_message', { participantId: participantId, text: text, replyTo: replyTo || null }, 3);
        return r.message;
      },

      /* Видео как отдельная карточка в ленте чата — не просто текстовое
         уведомление о загрузке, а полноценное сообщение со своим
         превью, на которое можно реагировать и под которым можно
         обсуждать, как и любое другое сообщение. */
      sendVideo: async function (participantId, video, caption) {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) {
          throw new Error('Чат работает только при включённой облачной синхронизации');
        }
        var r = await apiRetry(cfg.url, 'send_message', {
          participantId: participantId, type: 'video', text: caption || '',
          videoPath: video.path, videoExt: video.ext, videoThumb: video.thumb || null,
          videoReps: video.reps || null, videoDate: video.date
        }, 3);
        return r.message;
      },

      /* Одна реакция на человека на сообщение — повторный тап той же
         снимает, тап другой — переключает. Логика на бэкенде, тут
         просто вызов. */
      react: async function (participantId, messageId, emoji) {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) throw new Error('Облако не настроено');
        var r = await apiRetry(cfg.url, 'react_message', { participantId: participantId, messageId: messageId, emoji: emoji }, 3);
        return r.message;
      }
    }
  };

  global.Storage = Storage;
})(window);
