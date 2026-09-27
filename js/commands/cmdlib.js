/*
 * cmdlib.js — общие помощники команд.
 *
 * Здесь собрано то, что раньше дублировалось в net_diag / net_dns /
 * services_cmd / fs / text: разбор числовых аргументов с защитой от NaN
 * и бесконечных циклов, безопасная компиляция пользовательских регулярных
 * выражений, чтение stdin/файлов, единый перевод кодов ошибок сетевого
 * движка в текст и разрешение имён.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var E = NET.packet.E;

  /* ---------- числовые аргументы ---------- */

  /*
   * intArg(ctx, cmd, raw, def, opts) -> число | null (ошибка уже напечатана)
   * Защищает от `ping -c abc` (NaN => бесконечный цикл) и `ping -c 1e9`
   * (миллиард итераций => зависшая вкладка): значение проверяется и
   * ограничивается, о срезке пользователь узнаёт из stderr.
   */
  function intArg(ctx, cmd, raw, def, opts) {
    opts = opts || {};
    if (raw === undefined || raw === null || raw === '') return def;
    if (!U.isIntLike(raw)) {
      ctx.errLine(cmd + ': invalid argument: \'' + raw + '\'');
      return null;
    }
    var min = opts.min === undefined ? 1 : opts.min;
    var max = opts.max === undefined ? U.LIMITS.loopCount : opts.max;
    var n = U.clampInt(raw, def, min, max);
    if (opts.notify !== false && Number(raw) > max) {
      ctx.errLine(cmd + ': ограничение тренажёра: не больше ' + max + ' — использую ' + max);
    }
    return n;
  }

  /* Мягкий вариант: без сообщений, только безопасное значение. */
  function count(raw, def, max) {
    return U.clampInt(raw, def, 0, max === undefined ? U.LIMITS.loopCount : max);
  }

  /* ---------- регулярные выражения ---------- */

  /*
   * regex(ctx, cmd, pattern, flags) -> RegExp | null
   * Ошибка печатается в стиле самой утилиты, а не как «internal error»
   * с текстом движка JavaScript.
   */
  function regex(ctx, cmd, pattern, flags) {
    var res = U.safeRegExp(pattern, flags);
    if (res.err) {
      if (cmd === 'grep') ctx.errLine('grep: ' + res.err);
      else if (cmd === 'sed') ctx.errLine('sed: -e expression #1, char ' + String(pattern).length + ': ' + res.err);
      else if (cmd === 'find') ctx.errLine('find: invalid predicate argument: ' + res.err);
      else ctx.errLine(cmd + ': ' + res.err);
      return null;
    }
    return res.re;
  }

  /* Шаблон вида *.yaml -> регулярное выражение (find -name, ls). */
  function globRegex(ctx, cmd, pattern, flags) {
    var src = '^' + U.escapeRe(String(pattern))
      .replace(/\\\*/g, '.*')
      .replace(/\\\?/g, '.') + '$';
    return regex(ctx, cmd, src, flags);
  }

  /* ---------- ввод ---------- */

  function lines(data) {
    var l = String(data === undefined || data === null ? '' : data).split('\n');
    if (l.length && l[l.length - 1] === '') l.pop();
    return l;
  }

  /*
   * readFiles(ctx, files, cmd) -> строка | null (ошибка напечатана)
   * Без файлов читает stdin. Заголовки «==> файл <==» как у tail/head.
   */
  function readFiles(ctx, files, cmd, opts) {
    opts = opts || {};
    if (!files || !files.length) return ctx.stdin;
    var out = '';
    for (var i = 0; i < files.length; i++) {
      if (files[i] === '-') { out += ctx.stdin; continue; }
      if (opts.headers && files.length > 1) out += '==> ' + files[i] + ' <==\n';
      try {
        out += ctx.vfs.read(ctx.resolve(files[i]), ctx.fsctx);
      } catch (e) {
        ctx.errLine((cmd || ctx.argv0) + ': ' + files[i] + ': ' +
          (e && e.name === 'FsError' ? e.message : 'No such file or directory'));
        return null;
      }
      if (opts.headers && files.length > 1) out += '\n';
    }
    return out;
  }

  /* Единый перевод ошибок файловой системы в сообщение и exit code. */
  function fsError(ctx, cmd, e, path) {
    if (e && e.name === 'FsError') {
      ctx.errLine(cmd + ': ' + (path || e.path) + ': ' + e.message);
      if (e.code === 'ENOENT') return 2;
      return 1;
    }
    throw e;
  }

  /* ---------- сеть ---------- */

  /* Разрешение имени в адрес для ping/curl/ssh/nc: одна реализация на всех. */
  function resolveTarget(ctx, name) {
    if (U.isIPv4(name)) return { ip: name, name: name };
    if (name && name.indexOf(':') >= 0 && U.isIPv6(name)) return { ip: name, name: name, v6: true };
    var r = NET.dns.resolve(ctx.world, ctx.machine, name, { type: 'A' });
    if (!r.ip) return { err: r.status || 'TIMEOUT', name: name, status: r.status };
    return { ip: r.ip, name: name, resolved: true, status: r.status };
  }

  var CONNECT_TEXT = {};
  CONNECT_TEXT[E.REFUSED] = 'Connection refused';
  CONNECT_TEXT[E.NETUNREACH] = 'Network is unreachable';
  CONNECT_TEXT[E.HOSTUNREACH] = 'No route to host';
  CONNECT_TEXT[E.UNREACH_ADMIN] = 'Permission denied';
  CONNECT_TEXT[E.TIMEOUT] = 'Connection timed out';
  CONNECT_TEXT[E.BLACKHOLE] = 'Connection timed out';
  CONNECT_TEXT[E.PORTUNREACH] = 'Connection refused';
  CONNECT_TEXT[E.NETDOWN] = 'Network is down';
  CONNECT_TEXT[E.PERM] = 'Operation not permitted';
  CONNECT_TEXT[E.MSGSIZE] = 'Message too long';

  function connectErrorText(error) {
    return CONNECT_TEXT[error] || 'Connection timed out';
  }

  /* Обратное разрешение адреса в имя для traceroute/mtr. */
  function reverseName(ctx, ip) {
    var r = NET.dns.reverse(ctx.world, ctx.machine, ip);
    if (r && r.answers && r.answers.length) return r.answers[0].value.replace(/\.$/, '');
    var host = ctx.world.byIP(ip);
    return host ? host.hostname : null;
  }

  NET.cmdlib = {
    intArg: intArg,
    count: count,
    regex: regex,
    globRegex: globRegex,
    lines: lines,
    readFiles: readFiles,
    fsError: fsError,
    resolveTarget: resolveTarget,
    connectErrorText: connectErrorText,
    reverseName: reverseName,
    portName: U.portName
  };
})(window.NET);
