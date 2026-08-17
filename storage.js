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

   Если схема действий в реальном бэкенде Herald Chat отличается —
   меняются только имена action и форма params/ответа ниже,
   остальной код приложения (app.js) их не касается.
   ============================================================ */

(function (global) {
  'use strict';

  var LS_STATE = 'pcsport.state';
  var LS_CFG = 'pcsport.config';

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
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, params || {}))
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || data.error) {
      throw new Error(data.error_description || data.error || ('HTTP ' + res.status));
    }
    return data;
  }

  /* ============================================================
     Публичный интерфейс — сигнатуры прежние, чтобы app.js не менять
     ============================================================ */
  var Storage = {
    config: Config,

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
      return api(cfg.url, 'ping', {});
    },

    /* Забрать состояние из облака. Возвращает состояние или null. */
    pull: async function () {
      var cfg = Config.read();
      if (cfg.backend !== 'cloud' || !cfg.url) return null;
      var data = await api(cfg.url, 'get_state', {});
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
    merge: function (localState, remoteState) {
      if (!remoteState) return localState;
      if (!localState) return remoteState;
      var l = Date.parse(localState.updatedAt || 0) || 0;
      var r = Date.parse(remoteState.updatedAt || 0) || 0;
      return r > l ? remoteState : localState;
    },

    reset: function () { LS.del(LS_STATE); },

    /* ============================================================
       Видео — та же облачная функция, но байты идут напрямую
       браузер → Яндекс.Диск: функция лишь выдаёт временные ссылки
       на загрузку/скачивание и ведёт общий индекс роликов.
       ============================================================ */
    video: {
      supported: function () {
        var cfg = Config.read();
        return cfg.backend === 'cloud' && !!cfg.url;
      },

      upload: async function (participantId, date, blob, ext) {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) {
          throw new Error('Видео можно отправлять только при включённой облачной синхронизации');
        }
        var meta = await api(cfg.url, 'get_upload_url', { participantId: participantId, date: date, ext: ext });
        var put = await fetch(meta.uploadUrl, { method: 'PUT', body: blob });
        if (!put.ok) throw new Error('Не удалось загрузить видео на Диск (HTTP ' + put.status + ')');
        await api(cfg.url, 'confirm_upload', {
          participantId: participantId, date: date, videoId: meta.videoId, path: meta.path, ext: ext
        });
        return true;
      },

      list: async function () {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) return { items: [], retentionDays: 0 };
        return api(cfg.url, 'list_videos', {});
      },

      playUrl: async function (path) {
        var cfg = Config.read();
        if (cfg.backend !== 'cloud' || !cfg.url) throw new Error('Облако не настроено');
        var d = await api(cfg.url, 'get_download_url', { path: path });
        return d.url;
      }
    }
  };

  global.Storage = Storage;
})(window);
