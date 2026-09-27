/*
 * util.js — общие утилиты: работа с IPv4/IPv6, CIDR, форматирование,
 * генерация MAC/PID, клонирование состояния.
 */
(function (NET) {
  'use strict';

  var U = {};

  /* ---------- строки и форматирование ---------- */

  U.pad = function (s, n, right) {
    s = String(s);
    while (s.length < n) s = right ? s + ' ' : ' ' + s;
    return s;
  };

  U.padRight = function (s, n) { return U.pad(s, n, true); };

  U.repeat = function (s, n) {
    var out = '';
    for (var i = 0; i < n; i++) out += s;
    return out;
  };

  U.escapeHtml = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  U.clone = function (obj) { return JSON.parse(JSON.stringify(obj)); };

  U.randInt = function (a, b) { return a + Math.floor(Math.random() * (b - a + 1)); };

  /*
   * Единые лимиты песочницы. Тренажёр должен оставаться отзывчивым при любом
   * вводе, поэтому счётчики команд, размеры файлов и буферов ограничены здесь,
   * а не в каждом файле по-своему.
   */
  U.LIMITS = {
    cmdLine: 8192,          // длина одной командной строки (как ARG_MAX в миниатюре)
    pipeStages: 16,         // число команд в пайплайне
    loopCount: 100,         // -c/-n у ping, arping, tcpdump и подобных
    fileBytes: 262144,      // размер одного файла в виртуальной ФС (256 КиБ)
    vfsNodes: 20000,        // всего узлов в одной виртуальной ФС
    processes: 512,         // процессов на машину
    sockets: 256,           // сокетов на машину
    journal: 1200,          // записей в журнале машины
    capture: 4000,          // пакетов в буфере захвата
    labCommands: 2000,      // команд, запоминаемых лабораторией
    termNodes: 2600,        // узлов вывода в терминале
    regexSource: 512,       // длина пользовательского регулярного выражения
    outputChars: 400000     // вывод одной команды
  };

  /*
   * Целое число из пользовательского ввода: без NaN, Infinity и переполнений.
   * Возвращает def, если значение не число; всегда приводит к [min, max].
   */
  U.clampInt = function (value, def, min, max) {
    var n = typeof value === 'number' ? value : parseInt(String(value === undefined ? '' : value).trim(), 10);
    if (!isFinite(n)) return def;
    n = Math.trunc(n);
    if (min !== undefined && n < min) return min;
    if (max !== undefined && n > max) return max;
    return n;
  };

  /* true, если строка — корректное целое (для сообщений об ошибках как в GNU). */
  U.isIntLike = function (value) {
    return /^[+-]?\d+$/.test(String(value === undefined ? '' : value).trim());
  };

  /*
   * Компиляция пользовательского регулярного выражения.
   * Возвращает {re} либо {err}: вызывающий печатает ошибку в стиле утилиты,
   * а не «internal error» с текстом движка JS.
   */
  U.safeRegExp = function (pattern, flags) {
    var src = String(pattern === undefined ? '' : pattern);
    if (src.length > U.LIMITS.regexSource) {
      return { err: 'regular expression too long' };
    }
    try {
      return { re: new RegExp(src, flags || '') };
    } catch (e) {
      return { err: (e && e.message ? e.message.replace(/^Invalid regular expression:\s*/, '') : 'invalid regular expression') };
    }
  };

  /* Экранирование текста для использования внутри регулярного выражения. */
  U.escapeRe = function (s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  /* Обрезка строки с пометкой — для вывода, который не должен убить рендер. */
  U.truncate = function (s, max, note) {
    s = String(s === undefined ? '' : s);
    if (s.length <= max) return s;
    return s.slice(0, max) + (note === undefined ? '\n[вывод обрезан]\n' : note);
  };

  U.pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };

  U.shuffle = function (arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  U.uid = function (prefix) {
    return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 9);
  };

  U.randMac = function () {
    var parts = ['00', '0c', '29'];
    for (var i = 0; i < 3; i++) {
      parts.push(('0' + U.randInt(0, 255).toString(16)).slice(-2));
    }
    return parts.join(':');
  };

  /* ---------- время ---------- */

  U.now = function () { return Date.now(); };

  U.day = 24 * 3600 * 1000;

  /* Формат journalctl / syslog: "Sep 27 19:14:03" */
  U.syslogTime = function (ts) {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var d = new Date(ts || Date.now());
    return months[d.getMonth()] + ' ' + U.pad(d.getDate(), 2) + ' ' +
      U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes()) + ':' + U.pad2(d.getSeconds());
  };

  U.pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  U.lsTime = function (ts) {
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var d = new Date(ts || Date.now());
    return months[d.getMonth()] + ' ' + U.pad(d.getDate(), 2) + ' ' +
      U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes());
  };

  U.isoDate = function (ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + '-' + U.pad2(d.getMonth() + 1) + '-' + U.pad2(d.getDate());
  };

  U.humanSize = function (bytes) {
    var units = ['B', 'K', 'M', 'G', 'T'];
    var i = 0, v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : (v < 10 ? v.toFixed(1) : Math.round(v))) + units[i];
  };

  /* ---------- IPv4 ---------- */

  U.isIPv4 = function (s) {
    return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) &&
      s.split('.').every(function (o) { return Number(o) <= 255; });
  };

  U.ip2int = function (ip) {
    var p = ip.split('.');
    return ((Number(p[0]) << 24) >>> 0) + (Number(p[1]) << 16) +
      (Number(p[2]) << 8) + Number(p[3]);
  };

  U.int2ip = function (n) {
    n = n >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  };

  U.prefix2mask = function (prefix) {
    return prefix === 0 ? '0.0.0.0' : U.int2ip((0xFFFFFFFF << (32 - prefix)) >>> 0);
  };

  U.mask2prefix = function (mask) {
    var n = U.ip2int(mask), count = 0;
    for (var i = 31; i >= 0; i--) {
      if ((n >>> i) & 1) count++; else break;
    }
    return count;
  };

  /* "10.0.0.5/24" -> {ip, prefix} ; допускает форму без префикса */
  U.parseCidr = function (s, defPrefix) {
    var m = String(s).split('/');
    var ip = m[0];
    var prefix = m.length > 1 ? parseInt(m[1], 10) : (defPrefix === undefined ? 32 : defPrefix);
    if (!U.isIPv4(ip) || isNaN(prefix) || prefix < 0 || prefix > 32) return null;
    return { ip: ip, prefix: prefix };
  };

  U.network = function (ip, prefix) {
    var n = U.ip2int(ip);
    var mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
    return U.int2ip((n & mask) >>> 0);
  };

  U.broadcast = function (ip, prefix) {
    var n = U.ip2int(ip);
    var mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
    return U.int2ip(((n & mask) | (~mask >>> 0)) >>> 0);
  };

  U.sameSubnet = function (a, b, prefix) {
    if (!U.isIPv4(a) || !U.isIPv4(b)) return false;
    return U.network(a, prefix) === U.network(b, prefix);
  };

  U.inSubnet = function (ip, cidr) {
    var c = typeof cidr === 'string' ? U.parseCidr(cidr) : cidr;
    if (!c || !U.isIPv4(ip)) return false;
    return U.network(ip, c.prefix) === U.network(c.ip, c.prefix);
  };

  U.hostsInRange = function (startIp, endIp) {
    var out = [], a = U.ip2int(startIp), b = U.ip2int(endIp);
    for (var i = a; i <= b && out.length < 512; i++) out.push(U.int2ip(i));
    return out;
  };

  /* ---------- IPv6 (упрощённо, достаточно для тренажёра) ---------- */

  U.isIPv6 = function (s) {
    return typeof s === 'string' && s.indexOf(':') >= 0 && /^[0-9a-fA-F:]+$/.test(s);
  };

  /* Разворачивает "fe80::1" в 8 групп по 4 символа */
  U.expandV6 = function (s) {
    if (!U.isIPv6(s)) return null;
    var parts = s.toLowerCase().split('::');
    var head = parts[0] ? parts[0].split(':') : [];
    var tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
    var fill = 8 - head.length - tail.length;
    if (parts.length === 1) { fill = 0; if (head.length !== 8) return null; }
    var groups = head.slice();
    for (var i = 0; i < fill; i++) groups.push('0');
    groups = groups.concat(tail);
    if (groups.length !== 8) return null;
    return groups.map(function (g) { return ('0000' + g).slice(-4); }).join(':');
  };

  U.compressV6 = function (s) {
    var full = U.expandV6(s);
    if (!full) return s;
    var groups = full.split(':').map(function (g) { return g.replace(/^0+/, '') || '0'; });
    var str = groups.join(':');
    return str.replace(/\b(?:0:){2,}0\b/, ':').replace(/^:/, '::').replace(/:$/, '::')
      .replace(/:::+/, '::');
  };

  U.v6SameNet = function (a, b, prefix) {
    var A = U.expandV6(a), B = U.expandV6(b);
    if (!A || !B) return false;
    var nib = Math.floor(prefix / 4);
    var ha = A.replace(/:/g, ''), hb = B.replace(/:/g, '');
    return ha.slice(0, nib) === hb.slice(0, nib);
  };

  U.isV6LinkLocal = function (a) {
    var A = U.expandV6(a);
    return !!A && A.indexOf('fe80:') === 0;
  };

  /* Имена известных портов — нужны и захвату пакетов, и утилитам. */
  var PORT_NAMES = {
    20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain',
    67: 'bootps', 68: 'bootpc', 80: 'http', 110: 'pop3', 123: 'ntp', 143: 'imap',
    161: 'snmp', 443: 'https', 445: 'microsoft-ds', 465: 'smtps', 514: 'syslog',
    587: 'submission', 631: 'ipp', 993: 'imaps', 995: 'pop3s', 1194: 'openvpn',
    3306: 'mysql', 3389: 'ms-wbt-server', 5201: 'iperf3', 5432: 'postgresql',
    5353: 'mdns', 6379: 'redis', 8080: 'http-alt', 8443: 'https-alt'
  };

  U.portName = function (port) {
    return PORT_NAMES[Number(port)] || String(port);
  };

  U.portNumber = function (name) {
    if (U.isIntLike(name)) return Number(name);
    var found = null;
    Object.keys(PORT_NAMES).forEach(function (p) {
      if (PORT_NAMES[p] === name && found === null) found = Number(p);
    });
    return found;
  };

  /* ---------- прочее ---------- */

  U.columns = function (items, width) {
    if (!items.length) return '';
    width = width || 80;
    var max = 0;
    items.forEach(function (i) { if (i.length > max) max = i.length; });
    var colw = max + 2;
    var cols = Math.max(1, Math.floor(width / colw));
    var rows = Math.ceil(items.length / cols);
    var lines = [];
    for (var r = 0; r < rows; r++) {
      var line = '';
      for (var c = 0; c < cols; c++) {
        var idx = c * rows + r;
        if (idx < items.length) line += U.padRight(items[idx], colw);
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  };

  U.commonPrefix = function (list) {
    if (!list.length) return '';
    var p = list[0];
    for (var i = 1; i < list.length; i++) {
      while (p && list[i].indexOf(p) !== 0) p = p.slice(0, -1);
    }
    return p;
  };

  U.sleep = function (ms) {
    return new Promise(function (res) { setTimeout(res, ms); });
  };

  NET.util = U;
})(window.NET);
