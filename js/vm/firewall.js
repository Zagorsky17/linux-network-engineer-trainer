/*
 * firewall.js — одна модель Netfilter для трёх фронтендов.
 *
 * iptables, nft и ufw правят одно и то же состояние: правило, добавленное
 * через `ufw allow 443/tcp`, видно в `iptables -L -n` и реально влияет на
 * прохождение пакета, потому что packet.js вызывает evaluate() в точках
 * OUTPUT / FORWARD / INPUT.
 */
(function (NET) {
  'use strict';

  var U = NET.util;

  function Firewall(machine) {
    this.machine = machine;
    this.policy = { INPUT: 'ACCEPT', OUTPUT: 'ACCEPT', FORWARD: 'ACCEPT' };
    this.chains = { INPUT: [], OUTPUT: [], FORWARD: [] };
    this.ufw = {
      enabled: false,
      defaults: { incoming: 'deny', outgoing: 'allow', routed: 'deny' },
      rules: []
    };
    this.counters = { dropped: 0, accepted: 0, rejected: 0 };
  }

  /* ---------- iptables-слой ---------- */

  Firewall.prototype.addRule = function (chain, rule, opts) {
    opts = opts || {};
    if (!this.chains[chain]) return { err: 'iptables: No chain/target/match by that name.' };
    var r = {
      proto: rule.proto || 'all',
      src: rule.src || null,
      dst: rule.dst || null,
      dport: rule.dport === undefined ? null : rule.dport,
      sport: rule.sport === undefined ? null : rule.sport,
      iface: rule.iface || null,
      outIface: rule.outIface || null,
      states: rule.states || null,
      icmpType: rule.icmpType || null,
      target: rule.target || 'ACCEPT',
      comment: rule.comment || null,
      origin: rule.origin || 'iptables'
    };
    if (opts.insert) this.chains[chain].unshift(r);
    else this.chains[chain].push(r);
    return { ok: true, rule: r };
  };

  Firewall.prototype.delRule = function (chain, matcher) {
    var list = this.chains[chain];
    if (!list) return { err: 'iptables: No chain/target/match by that name.' };
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var same = true;
      Object.keys(matcher).forEach(function (k) {
        if (matcher[k] === undefined || matcher[k] === null) return;
        if (String(r[k]) !== String(matcher[k])) same = false;
      });
      if (same) { list.splice(i, 1); return { ok: true }; }
    }
    return { err: 'iptables: Bad rule (does a matching rule exist in that chain?).' };
  };

  Firewall.prototype.flush = function (chain) {
    if (chain) this.chains[chain] = [];
    else this.chains = { INPUT: [], OUTPUT: [], FORWARD: [] };
  };

  /* ---------- ufw-слой ---------- */

  Firewall.prototype.ufwAdd = function (rule, opts) {
    opts = opts || {};
    var r = {
      action: rule.action || 'allow',       // allow | deny | reject | limit
      direction: rule.direction || 'in',
      proto: rule.proto || 'any',
      port: rule.port === undefined ? null : rule.port,
      from: rule.from || 'any',
      to: rule.to || 'any',
      comment: rule.comment || null
    };
    var dup = this.ufw.rules.some(function (x) {
      return x.action === r.action && x.direction === r.direction &&
        String(x.port) === String(r.port) && x.proto === r.proto && x.from === r.from;
    });
    if (dup) return { ok: true, dup: true, rule: r };
    /* ufw insert N: порядок правил важен — срабатывает первое совпавшее */
    if (opts.index !== undefined && opts.index >= 0 && opts.index < this.ufw.rules.length) {
      this.ufw.rules.splice(opts.index, 0, r);
    } else {
      this.ufw.rules.push(r);
    }
    return { ok: true, rule: r };
  };

  Firewall.prototype.ufwDelete = function (matcher) {
    for (var i = 0; i < this.ufw.rules.length; i++) {
      var r = this.ufw.rules[i];
      if (matcher.num !== undefined) {
        if (i === matcher.num - 1) { this.ufw.rules.splice(i, 1); return { ok: true }; }
        continue;
      }
      if (String(r.port) === String(matcher.port) &&
        (matcher.proto === undefined || r.proto === matcher.proto) &&
        (matcher.from === undefined || r.from === matcher.from) &&
        (matcher.to === undefined || r.to === matcher.to) &&
        (matcher.action === undefined || r.action === matcher.action) &&
        (matcher.direction === undefined || r.direction === matcher.direction)) {
        this.ufw.rules.splice(i, 1);
        return { ok: true };
      }
    }
    return { err: 'Could not delete non-existent rule' };
  };

  /* ---------- вычисление вердикта ---------- */

  function portMatch(rulePort, pktPort) {
    if (rulePort === null || rulePort === undefined || rulePort === 'any') return true;
    if (pktPort === undefined || pktPort === null) return false;
    var s = String(rulePort);
    if (s.indexOf(':') > 0) {
      var p = s.split(':');
      return Number(pktPort) >= Number(p[0]) && Number(pktPort) <= Number(p[1]);
    }
    return Number(s) === Number(pktPort);
  }

  function addrMatch(ruleAddr, pktAddr) {
    if (!ruleAddr || ruleAddr === 'any' || ruleAddr === '0.0.0.0/0') return true;
    if (!pktAddr) return false;
    if (ruleAddr.indexOf('/') > 0) return U.inSubnet(pktAddr, ruleAddr);
    return ruleAddr === pktAddr;
  }

  function ruleMatches(r, pkt) {
    if (r.proto && r.proto !== 'all' && r.proto !== 'any' && r.proto !== pkt.proto) return false;
    if (!addrMatch(r.src, pkt.src)) return false;
    if (!addrMatch(r.dst, pkt.dst)) return false;
    if (r.dport !== null && r.dport !== undefined && !portMatch(r.dport, pkt.dport)) return false;
    if (r.sport !== null && r.sport !== undefined && !portMatch(r.sport, pkt.sport)) return false;
    if (r.iface && r.iface !== pkt.inIface) return false;
    if (r.outIface && r.outIface !== pkt.outIface) return false;
    if (r.states && r.states.length) {
      var st = pkt.ct || 'NEW';
      var ok = r.states.some(function (s) {
        return s === st || (s === 'RELATED' && st === 'RELATED');
      });
      if (!ok) return false;
    }
    if (r.icmpType && pkt.proto === 'icmp' && pkt.icmpType && r.icmpType !== pkt.icmpType) return false;
    return true;
  }

  /*
   * Возвращает 'ACCEPT' | 'DROP' | 'REJECT'.
   * pkt: {proto, src, dst, sport, dport, inIface, outIface, ct, icmpType}
   */
  Firewall.prototype.evaluate = function (chain, pkt) {
    var list = this.chains[chain] || [];
    for (var i = 0; i < list.length; i++) {
      if (ruleMatches(list[i], pkt)) {
        var t = list[i].target;
        if (t === 'LOG') continue;
        this._count(t);
        return t;
      }
    }

    if (this.ufw.enabled) {
      var lo = (pkt.inIface === 'lo' || pkt.outIface === 'lo');
      if (lo) return 'ACCEPT';
      if (chain === 'INPUT') {
        if ((pkt.ct || 'NEW') !== 'NEW') return 'ACCEPT';
        for (var j = 0; j < this.ufw.rules.length; j++) {
          var ur = this.ufw.rules[j];
          if (ur.direction !== 'in') continue;
          if (ur.proto !== 'any' && ur.proto !== pkt.proto) continue;
          if (!portMatch(ur.port, pkt.dport)) continue;
          if (!addrMatch(ur.from === 'any' ? null : ur.from, pkt.src)) continue;
          if (ur.to !== 'any' && !addrMatch(ur.to, pkt.dst)) continue;
          var act = ur.action === 'deny' ? 'DROP' : (ur.action === 'reject' ? 'REJECT' : 'ACCEPT');
          /* limit: как ufw — не больше 6 новых подключений с адреса за 30 секунд */
          if (ur.action === 'limit') {
            if (pkt.flood) act = 'DROP';          // флудер упирается в лимит
            else if (!pkt.dry) act = this._limited(pkt.src, pkt.dport) ? 'DROP' : 'ACCEPT';
          }
          this._count(act);
          return act;
        }
        // ufw всегда пропускает ICMP echo-request по умолчанию
        if (pkt.proto === 'icmp') return 'ACCEPT';
        var def = this.ufw.defaults.incoming;
        var verdict = def === 'allow' ? 'ACCEPT' : (def === 'reject' ? 'REJECT' : 'DROP');
        this._count(verdict);
        return verdict;
      }
      if (chain === 'OUTPUT') {
        for (var o = 0; o < this.ufw.rules.length; o++) {
          var or = this.ufw.rules[o];
          if (or.direction !== 'out') continue;
          if (or.proto !== 'any' && or.proto !== pkt.proto) continue;
          if (!portMatch(or.port, pkt.dport)) continue;
          if (!addrMatch(or.to === 'any' ? null : or.to, pkt.dst)) continue;
          var oa = or.action === 'deny' ? 'DROP' : (or.action === 'reject' ? 'REJECT' : 'ACCEPT');
          this._count(oa);
          return oa;
        }
        var od = this.ufw.defaults.outgoing;
        return od === 'allow' ? 'ACCEPT' : 'DROP';
      }
      if (chain === 'FORWARD') {
        for (var k = 0; k < this.ufw.rules.length; k++) {
          var fr = this.ufw.rules[k];
          if (fr.direction !== 'routed') continue;
          if (fr.proto !== 'any' && fr.proto !== pkt.proto) continue;
          if (!portMatch(fr.port, pkt.dport)) continue;
          return fr.action === 'allow' ? 'ACCEPT' : 'DROP';
        }
        return this.ufw.defaults.routed === 'allow' ? 'ACCEPT' : 'DROP';
      }
    }

    var p = this.policy[chain] || 'ACCEPT';
    this._count(p);
    return p;
  };

  Firewall.prototype._limited = function (src, port) {
    var key = src + '>' + port, now = Date.now();
    this.limitHits = this.limitHits || {};
    var hits = (this.limitHits[key] || []).filter(function (t) { return now - t < 30000; });
    hits.push(now);
    this.limitHits[key] = hits.slice(-20);
    return hits.length > 6;
  };

  Firewall.prototype._count = function (t) {
    if (t === 'DROP') this.counters.dropped++;
    else if (t === 'REJECT') this.counters.rejected++;
    else this.counters.accepted++;
  };

  /* Открыт ли порт с точки зрения фильтра (для проверок в лабораториях). */
  Firewall.prototype.allowsInput = function (proto, port, src) {
    return this.evaluate('INPUT', {
      proto: proto, dport: port, src: src || '0.0.0.0', dst: null, ct: 'NEW', inIface: 'ens33', dry: true
    }) === 'ACCEPT';
  };

  /* ---------- рендеринг ---------- */

  function fmtTarget(t) { return t; }

  /* Правила ufw, спроецированные в цепочку INPUT — так их видит iptables -L. */
  Firewall.prototype.effectiveInput = function () {
    var out = this.chains.INPUT.slice();
    if (this.ufw.enabled) {
      out = out.concat([{ proto: 'all', src: null, dst: null, states: ['ESTABLISHED', 'RELATED'], target: 'ACCEPT', origin: 'ufw', comment: 'ufw-before-input' }]);
      this.ufw.rules.forEach(function (r) {
        if (r.direction !== 'in') return;
        out.push({
          proto: r.proto === 'any' ? 'all' : r.proto,
          src: r.from === 'any' ? null : r.from,
          dst: null, dport: r.port, target: r.action === 'allow' ? 'ACCEPT' : (r.action === 'reject' ? 'REJECT' : 'DROP'),
          origin: 'ufw', comment: r.comment
        });
      });
      out.push({ proto: 'all', target: this.ufw.defaults.incoming === 'allow' ? 'ACCEPT' : 'DROP', origin: 'ufw', comment: 'ufw-default-incoming' });
    }
    return out;
  };

  Firewall.prototype.renderIptablesList = function (chain, numeric, verbose, lineNumbers) {
    var self = this;
    var lines = [];
    var chains = chain ? [chain] : ['INPUT', 'FORWARD', 'OUTPUT'];
    chains.forEach(function (c) {
      var pol = self.ufw.enabled && c === 'INPUT' ? 'DROP' : self.policy[c];
      lines.push('Chain ' + c + ' (policy ' + pol + ')');
      lines.push((lineNumbers ? 'num  ' : '') + 'target     prot opt source               destination         ');
      var rules = c === 'INPUT' ? self.effectiveInput() : self.chains[c];
      rules.forEach(function (r, n) {
        var extra = [];
        if (r.dport) extra.push((r.proto === 'udp' ? 'udp' : 'tcp') + ' dpt:' + r.dport);
        if (r.sport) extra.push('spt:' + r.sport);
        if (r.states) extra.push('ctstate ' + r.states.join(','));
        if (r.iface) extra.push('in:' + r.iface);
        if (r.comment) extra.push('/* ' + r.comment + ' */');
        lines.push((lineNumbers ? U.padRight(String(n + 1), 5) : '') + U.padRight(fmtTarget(r.target), 11) +
          U.padRight(r.proto === 'all' ? 'all' : r.proto, 5) + '--  ' +
          U.padRight(r.src || 'anywhere', 21) +
          U.padRight(r.dst || 'anywhere', 20) +
          extra.join(' '));
      });
      lines.push('');
    });
    return lines.join('\n').replace(/\n+$/, '\n');
  };

  Firewall.prototype.renderIptablesSave = function () {
    var self = this;
    var lines = ['# Generated by iptables-save', '*filter'];
    ['INPUT', 'FORWARD', 'OUTPUT'].forEach(function (c) {
      lines.push(':' + c + ' ' + (self.ufw.enabled && c === 'INPUT' ? 'DROP' : self.policy[c]) + ' [0:0]');
    });
    ['INPUT', 'FORWARD', 'OUTPUT'].forEach(function (c) {
      var rules = c === 'INPUT' ? self.effectiveInput() : self.chains[c];
      rules.forEach(function (r) {
        var s = '-A ' + c;
        if (r.iface) s += ' -i ' + r.iface;
        if (r.src) s += ' -s ' + r.src;
        if (r.dst) s += ' -d ' + r.dst;
        if (r.proto && r.proto !== 'all') s += ' -p ' + r.proto;
        if (r.dport) s += ' --dport ' + r.dport;
        if (r.states) s += ' -m conntrack --ctstate ' + r.states.join(',');
        s += ' -j ' + r.target;
        lines.push(s);
      });
    });
    lines.push('COMMIT');
    return lines.join('\n') + '\n';
  };

  Firewall.prototype.renderNft = function () {
    var self = this;
    var lines = ['table inet filter {'];
    ['input', 'forward', 'output'].forEach(function (c) {
      var name = c.toUpperCase();
      var pol = self.ufw.enabled && name === 'INPUT' ? 'drop' : self.policy[name].toLowerCase();
      lines.push('\tchain ' + c + ' {');
      lines.push('\t\ttype filter hook ' + c + ' priority filter; policy ' + pol + ';');
      var rules = name === 'INPUT' ? self.effectiveInput() : self.chains[name];
      rules.forEach(function (r) {
        var parts = [];
        if (r.iface) parts.push('iifname "' + r.iface + '"');
        if (r.src) parts.push('ip saddr ' + r.src);
        if (r.dst) parts.push('ip daddr ' + r.dst);
        if (r.states) parts.push('ct state ' + r.states.join(',').toLowerCase());
        if (r.proto && r.proto !== 'all') parts.push(r.proto);
        if (r.dport) parts.push('dport ' + r.dport);
        parts.push(r.target.toLowerCase());
        lines.push('\t\t' + parts.join(' '));
      });
      lines.push('\t}');
    });
    lines.push('}');
    return lines.join('\n');
  };

  Firewall.prototype.renderUfwStatus = function (numbered, verbose) {
    if (!this.ufw.enabled) return 'Status: inactive';
    var lines = ['Status: active'];
    if (verbose) {
      lines.push('Logging: on (low)');
      lines.push('Default: ' + this.ufw.defaults.incoming + ' (incoming), ' +
        this.ufw.defaults.outgoing + ' (outgoing), ' + this.ufw.defaults.routed + ' (routed)');
      lines.push('New profiles: skip');
    }
    lines.push('');
    if (numbered) {
      lines.push('     To                         Action      From');
      lines.push('     --                         ------      ----');
    } else {
      lines.push('To                         Action      From');
      lines.push('--                         ------      ----');
    }
    this.ufw.rules.forEach(function (r, i) {
      var portStr = r.port === null ? '' : (r.port + (r.proto !== 'any' ? '/' + r.proto : ''));
      var to = r.to !== 'any' ? r.to + (portStr ? ' ' + portStr : '') : (portStr || 'Anywhere');
      var action = r.action.toUpperCase() + (r.direction === 'in' ? '' : ' OUT');
      var from = r.from === 'any' ? 'Anywhere' : r.from;
      var prefix = numbered ? '[' + U.pad(i + 1, 2) + '] ' : '';
      lines.push(prefix + U.padRight(to, 27) + U.padRight(action, 12) + from +
        (r.comment ? ' # ' + r.comment : ''));
    });
    return lines.join('\n');
  };

  Firewall.prototype.snapshot = function () {
    return U.clone({ policy: this.policy, chains: this.chains, ufw: this.ufw });
  };

  Firewall.prototype.restore = function (s) {
    var c = U.clone(s);
    this.policy = c.policy; this.chains = c.chains; this.ufw = c.ufw;
  };

  NET.Firewall = Firewall;
})(window.NET);
