/* ============================================================
   log.js — журнал событий приложения.

   Цель: когда что-то не работает, не пересказывать словами и не
   присылать скриншот с одной строкой ошибки — а скопировать реальный
   лог и прислать текстом. Копится в localStorage, переживает
   перезагрузку страницы, ограничен по размеру, чтобы не разрастись
   бесконечно.
   ============================================================ */

(function (global) {
  'use strict';

  var LS_KEY = 'pcsport.log';
  var MAX_LINES = 400;
  var listeners = [];

  function read() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; }
    catch (e) { return []; }
  }

  function write(lines) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(lines.slice(-MAX_LINES))); }
    catch (e) { /* переполнен localStorage — переживём без логов, не без приложения */ }
  }

  function add(level, msg) {
    var lines = read();
    var entry = { t: new Date().toISOString(), level: level, msg: String(msg) };
    lines.push(entry);
    write(lines);
    listeners.forEach(function (fn) { try { fn(entry); } catch (e) {} });
    return entry;
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
  }

  var Log = {
    info: function (msg) { return add('info', msg); },
    warn: function (msg) { return add('warn', msg); },
    error: function (msg) { return add('error', msg); },
    all: function () { return read(); },
    clear: function () { write([]); },
    onAdd: function (fn) { listeners.push(fn); },
    fmtTime: fmtTime,
    asText: function () {
      return read().map(function (e) {
        return '[' + fmtTime(e.t) + '] ' + e.level.toUpperCase() + ': ' + e.msg;
      }).join('\n');
    }
  };

  global.PCLog = Log;
})(window);
