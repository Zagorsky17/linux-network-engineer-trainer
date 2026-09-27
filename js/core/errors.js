/*
 * errors.js — централизованная обработка ошибок.
 *
 * Правило проекта: ошибку либо обрабатывают осмысленно, либо сообщают через
 * этот модуль. Пустые catch {} запрещены — вместо них NET.errors.report(),
 * который пишет в консоль, ведёт журнал последних ошибок и (если интерфейс уже
 * загружен) показывает уведомление. Ошибка в одном обработчике никогда
 * не должна ломать приложение целиком.
 */
(function (NET) {
  'use strict';

  var MAX_LOG = 50;
  var log = [];
  var installed = false;

  function short(e) {
    if (!e) return 'unknown error';
    if (typeof e === 'string') return e;
    return (e.name ? e.name + ': ' : '') + (e.message || String(e));
  }

  /*
   * report(err, where, opts)
   *   where — короткое место в коде («vfs.write», «ui.render:labs»)
   *   opts.silent — не показывать уведомление (для фонового шума)
   *   opts.level  — 'error' | 'warn'
   */
  function report(err, where, opts) {
    opts = opts || {};
    var entry = {
      at: Date.now(),
      where: where || 'unknown',
      message: short(err),
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : null,
      level: opts.level || 'error'
    };
    log.push(entry);
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);

    if (window.console) {
      var fn = entry.level === 'warn' ? console.warn : console.error;
      fn.call(console, '[' + entry.where + '] ' + entry.message, err && err.stack ? err : '');
    }
    if (!opts.silent && NET.ui && NET.ui.notify) {
      try {
        NET.ui.notify.raw(entry.level === 'warn' ? 'warn' : 'err',
          'Внутренняя ошибка', entry.where + ': ' + entry.message);
      } catch (e) { /* уведомления недоступны — уже записали в консоль и журнал */ }
    }
    try { NET.bus.emit('error:reported', entry); } catch (e) { /* шина не должна усугублять */ }
    return entry;
  }

  /* Обёртка вокруг колбэков: ошибка не прорывается наружу и не рвёт поток. */
  function guard(where, fn, fallback) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { report(e, where); return fallback; }
    };
  }

  /* Синхронный вызов с безопасным значением по умолчанию. */
  function attempt(where, fn, fallback, opts) {
    try { return fn(); }
    catch (e) { report(e, where, opts); return fallback; }
  }

  /* Глобальные перехватчики: любая необработанная ошибка видна пользователю. */
  function install() {
    if (installed || !window.addEventListener) return;
    installed = true;
    window.addEventListener('error', function (ev) {
      report(ev.error || ev.message, 'window.onerror', { silent: false });
    });
    window.addEventListener('unhandledrejection', function (ev) {
      report(ev.reason, 'unhandledRejection', { silent: false });
    });
  }

  NET.errors = {
    report: report,
    guard: guard,
    attempt: attempt,
    install: install,
    log: function () { return log.slice(); },
    clear: function () { log = []; },
    describe: short
  };
})(window.NET);
