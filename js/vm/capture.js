/*
 * capture.js — кольцевой буфер пакетов и фильтр в стиле pcap.
 * tcpdump в тренажёре печатает то, что действительно прошло через модель,
 * а не заготовленный текст. Для Lab09 буфер можно наполнить готовым дампом.
 */
(function (NET) {
  'use strict';

  var U = NET.util;

  function Capture(max) {
    this.buf = [];
    this.max = max || U.LIMITS.capture;
    this.enabled = true;
    this.t0 = Date.now();
  }

  Capture.prototype.record = function (p) {
    if (!this.enabled) return;
    p.ts = p.ts || Date.now();
    this.buf.push(p);
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max);
  };

  Capture.prototype.clear = function () { this.buf = []; };

  /* Готовый дамп: подставляем последовательные метки времени. */
  Capture.prototype.load = function (records, node, iface) {
    var t = Date.now() - records.length * 40;
    var self = this;
    records.forEach(function (r, i) {
      var c = U.clone(r);
      c.node = c.node || node;
      c.iface = c.iface || iface;
      c.ts = t + i * (c.gap === undefined ? 40 : c.gap);
      self.record(c);
    });
  };

  /* ---------- фильтр pcap ---------- */

  function tokenize(expr) {
    return String(expr || '').replace(/\(/g, ' ( ').replace(/\)/g, ' ) ')
      .trim().split(/\s+/).filter(Boolean);
  }

  /*
   * Поддержано подмножество, которое реально нужно инженеру:
   * host/src host/dst host, net, port/src port/dst port, portrange,
   * tcp/udp/icmp/arp, tcp[tcpflags] & tcp-syn != 0, and/or/not, скобки.
   */
  function parse(tokens) {
    var pos = 0;

    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }

    function parseOr() {
      var left = parseAnd();
      while (peek() === 'or' || peek() === '||') {
        next();
        var right = parseAnd();
        left = (function (a, b) { return function (r) { return a(r) || b(r); }; })(left, right);
      }
      return left;
    }

    function parseAnd() {
      var left = parseNot();
      while (peek() === 'and' || peek() === '&&' ||
        (peek() && ['or', ')', '||'].indexOf(peek()) < 0 && looksLikePrimitiveStart(peek()))) {
        if (peek() === 'and' || peek() === '&&') next();
        var right = parseNot();
        left = (function (a, b) { return function (r) { return a(r) && b(r); }; })(left, right);
      }
      return left;
    }

    function looksLikePrimitiveStart(t) {
      return ['host', 'net', 'port', 'src', 'dst', 'tcp', 'udp', 'icmp', 'arp', 'not',
        '!', '(', 'portrange', 'ether', 'ip', 'ip6', 'greater', 'less'].indexOf(t) >= 0;
    }

    function parseNot() {
      if (peek() === 'not' || peek() === '!') {
        next();
        var inner = parseNot();
        return function (r) { return !inner(r); };
      }
      return parsePrimitive();
    }

    function parsePrimitive() {
      var t = next();
      if (t === '(') {
        var inner = parseOr();
        if (peek() === ')') next();
        return inner;
      }
      if (t === 'src' || t === 'dst') {
        var dir = t;
        var kind = peek();
        if (kind === 'host' || kind === 'port' || kind === 'net') next();
        else kind = 'host';
        var val = next();
        return makeDir(dir, kind, val);
      }
      if (t === 'host') { var h = next(); return function (r) { return r.src === h || r.dst === h; }; }
      if (t === 'net') {
        var n = next();
        if (n.indexOf('/') < 0) n = n + '/24';
        return function (r) { return U.inSubnet(r.src || '', n) || U.inSubnet(r.dst || '', n); };
      }
      if (t === 'port') {
        var p = Number(next());
        return function (r) { return Number(r.sport) === p || Number(r.dport) === p; };
      }
      if (t === 'portrange') {
        var range = next().split('-');
        return function (r) {
          return inRange(r.sport, range) || inRange(r.dport, range);
        };
      }
      if (t === 'tcp' || t === 'udp' || t === 'icmp' || t === 'arp' || t === 'icmp6') {
        if (peek() === 'port') { next(); var pp = Number(next());
          return function (r) { return r.proto === t && (Number(r.sport) === pp || Number(r.dport) === pp); };
        }
        return function (r) { return r.proto === t; };
      }
      if (t === 'ip') return function (r) { return r.proto !== 'arp'; };
      if (t === 'ip6') return function (r) { return (r.src || '').indexOf(':') >= 0; };
      if (t === 'greater') { var g = Number(next()); return function (r) { return (r.len || 0) > g; }; }
      if (t === 'less') { var l = Number(next()); return function (r) { return (r.len || 0) < l; }; }
      if (/^tcp\[/.test(t)) {
        /* tcp[tcpflags] & tcp-syn != 0 */
        var rest = tokens.slice(pos).join(' ');
        pos = tokens.length;
        var want = [];
        if (/tcp-syn/.test(rest)) want.push('S');
        if (/tcp-ack/.test(rest)) want.push('.');
        if (/tcp-fin/.test(rest)) want.push('F');
        if (/tcp-rst/.test(rest)) want.push('R');
        var negate = /!=\s*0/.test(rest) ? false : /==\s*0/.test(rest);
        return function (r) {
          if (r.proto !== 'tcp') return false;
          var f = r.flags || '';
          var hit = want.some(function (w) { return f.indexOf(w) >= 0; });
          return negate ? !hit : hit;
        };
      }
      if (U.isIPv4(t)) return function (r) { return r.src === t || r.dst === t; };
      return function () { return true; };
    }

    function inRange(v, range) {
      return v !== undefined && Number(v) >= Number(range[0]) && Number(v) <= Number(range[1]);
    }

    function makeDir(dir, kind, val) {
      if (kind === 'port') {
        var p = Number(val);
        return dir === 'src'
          ? function (r) { return Number(r.sport) === p; }
          : function (r) { return Number(r.dport) === p; };
      }
      if (kind === 'net') {
        var n = val.indexOf('/') < 0 ? val + '/24' : val;
        return dir === 'src'
          ? function (r) { return U.inSubnet(r.src || '', n); }
          : function (r) { return U.inSubnet(r.dst || '', n); };
      }
      return dir === 'src'
        ? function (r) { return r.src === val; }
        : function (r) { return r.dst === val; };
    }

    var fn = parseOr();
    return fn;
  }

  /* Грубая, но полезная валидация: несбалансированные скобки и primitive
     без операнда — это синтаксическая ошибка, как и в настоящем tcpdump. */
  function validate(tokens) {
    var depth = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t === '(') { depth++; continue; }
      if (t === ')') { depth--; if (depth < 0) return false; continue; }
      if (['host', 'net', 'port', 'portrange'].indexOf(t) >= 0) {
        var operand = tokens[i + 1];
        if (!operand || ['(', ')', 'and', 'or', 'not', '&&', '||', '!'].indexOf(operand) >= 0) return false;
        if (t === 'port' && !/^\d+$/.test(operand)) return false;
        if (t === 'portrange' && !/^\d+-\d+$/.test(operand)) return false;
        if (t === 'host' && !/^[0-9a-fA-F.:]+$/.test(operand)) return false;
      }
      if (t === 'src' || t === 'dst') {
        if (!tokens[i + 1]) return false;
      }
    }
    return depth === 0;
  }

  Capture.prototype.filter = function (expr) {
    var tokens = tokenize(expr);
    if (!tokens.length) return function () { return true; };
    if (!validate(tokens)) return null;
    try { return parse(tokens); } catch (e) { return null; }
  };

  /*
   * query({node, iface, expr, limit, since}) -> массив записей
   */
  Capture.prototype.query = function (opts) {
    opts = opts || {};
    var f = this.filter(opts.expr);
    if (!f) return null;
    var out = [];
    for (var i = 0; i < this.buf.length; i++) {
      var r = this.buf[i];
      if (opts.node && r.node !== opts.node) continue;
      if (opts.iface && opts.iface !== 'any' && r.iface !== opts.iface) continue;
      if (opts.since && r.ts < opts.since) continue;
      if (!f(r)) continue;
      out.push(r);
    }
    if (opts.limit) out = out.slice(-opts.limit);
    return out;
  };

  /* Формат строки tcpdump. */
  Capture.prototype.format = function (r, opts) {
    opts = opts || {};
    var d = new Date(r.ts);
    var ms = ('00000' + (r.ts % 1000)).slice(-3) + String(U.randInt(100, 999));
    var t = U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes()) + ':' + U.pad2(d.getSeconds()) + '.' + ms;
    var line = t + ' ';
    if (opts.e) {
      line += (r.srcMac || '00:00:00:00:00:00') + ' > ' + (r.dstMac || 'ff:ff:ff:ff:ff:ff') + ', ';
      line += 'ethertype ' + (r.proto === 'arp' ? 'ARP (0x0806)' : 'IPv4 (0x0800)') + ', length ' + (r.len + 14) + ': ';
    }
    if (r.proto === 'arp') {
      line += 'ARP, ' + (r.info || ('Request who-has ' + r.dst + ' tell ' + r.src)) + ', length ' + r.len;
      return line;
    }
    if (r.proto === 'icmp') {
      line += 'IP ' + r.src + ' > ' + r.dst + ': ICMP ' +
        (r.icmpType || 'echo request') + ', id ' + (r.id || 1234) +
        ', seq ' + (r.seq || 1) + ', length ' + (r.len - 20);
      return line;
    }
    if (r.proto === 'udp') {
      line += 'IP ' + r.src + '.' + portName(r.sport) + ' > ' + r.dst + '.' + portName(r.dport) + ': ';
      line += r.info ? r.info : 'UDP, length ' + Math.max(0, r.len - 28);
      return line;
    }
    if (r.proto === 'tcp') {
      var flags = '[' + (r.flags === '.' ? '.' : (r.flags || 'S')) + ']';
      line += 'IP ' + r.src + '.' + portName(r.sport) + ' > ' + r.dst + '.' + portName(r.dport) + ': Flags ' +
        flags + ', seq ' + (r.seqno === undefined ? U.randInt(1000000, 9999999) : r.seqno) +
        ', win ' + (r.win || 64240) +
        (r.opts ? ', options [' + r.opts + ']' : '') +
        ', length ' + Math.max(0, r.len - 66);
      if (r.info) line += ' ' + r.info;
      return line;
    }
    line += 'IP ' + r.src + ' > ' + r.dst + ': ' + (r.info || r.proto);
    return line;
  };

  function portName(p) {
    var names = { 22: 'ssh', 53: 'domain', 80: 'http', 443: 'https', 67: 'bootps', 68: 'bootpc', 123: 'ntp', 3306: 'mysql' };
    return names[p] || p;
  }

  NET.Capture = Capture;
})(window.NET);
