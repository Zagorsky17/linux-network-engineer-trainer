/*
 * net_dns.js — dig, nslookup, host, resolvectl, getent.
 * Каждый запрос реально летит по сети через packet.js, поэтому по симптому
 * различимы: нет маршрута, сервер не отвечает, порт 53 закрыт, зоны нет.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;

  function nameComplete(ctx, word, argv, h) { return h.addrs(ctx); }

  reg({
    name: 'dig', category: 'dns', summary: 'DNS-запрос с полным ответом',
    usage: 'dig [@server] NAME [TYPE] [+short] [+trace] [-x ADDR]',
    complete: nameComplete,
    run: function (ctx) {
      var args = ctx.argv.slice();
      var server = null, short = false, trace = false, reverse = null, type = null, name = null;
      var plus = [];
      args.forEach(function (a) {
        if (a[0] === '@') server = a.slice(1);
        else if (a === '+short') short = true;
        else if (a === '+trace') trace = true;
        else if (a[0] === '+') plus.push(a);
        else if (a === '-x') reverse = 'pending';
        else if (reverse === 'pending') reverse = a;
        else if (/^(A|AAAA|MX|NS|TXT|SOA|CNAME|PTR|ANY)$/i.test(a) && name) type = a.toUpperCase();
        else if (!name) name = a;
      });

      if (reverse && reverse !== 'pending') {
        name = reverse.split('.').reverse().join('.') + '.in-addr.arpa';
        type = 'PTR';
      }
      if (!name) {
        ctx.line('; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>>');
        ctx.line(';; global options: +cmd');
        return 0;
      }
      type = type || 'A';

      var start = Date.now();
      var res = server
        ? NET.dns.queryServer(ctx.world, ctx.machine, server, name, type)
        : NET.dns.resolve(ctx.world, ctx.machine, name, { type: type, noHosts: true });
      var usedServer = server || (res.server || (NET.dns.resolvers(ctx.machine)[0] || 'none'));

      var slow = (res.status === 'TIMEOUT' || res.status === 'UNREACH');
      NET.bus.emit('probe:result', {
        from: ctx.machine.name, ip: usedServer, ok: res.status === 'NOERROR', kind: 'dns'
      });
      return ctx.sleep(slow ? 1100 : 60).then(function () {
        if (res.status === 'NORESOLVER') {
          ctx.errLine(';; no servers could be reached');
          ctx.errLine(';; (в /etc/resolv.conf нет ни одной строки nameserver)');
          return 9;
        }
        if (res.status === 'TIMEOUT' || res.status === 'UNREACH' || res.status === 'REFUSED') {
          if (short) return 9;
          var reason = res.status === 'UNREACH' ? 'host unreachable'
            : (res.status === 'REFUSED' ? 'connection refused' : 'timed out');
          for (var i = 0; i < 3; i++) {
            ctx.line(';; communications error to ' + usedServer + '#53: ' + reason);
          }
          ctx.line('');
          ctx.line(';; no servers could be reached');
          ctx.line('');
          return 9;
        }

        var answers = res.answers || [];
        if (short) {
          answers.filter(function (a) { return a.type === type || a.type === 'CNAME'; })
            .forEach(function (a) { ctx.line(a.value); });
          return answers.length ? 0 : 0;
        }

        ctx.line('');
        ctx.line('; <<>> DiG 9.18.28-0ubuntu0.24.04.1-Ubuntu <<>> ' + ctx.argv.join(' '));
        ctx.line(';; global options: +cmd');
        ctx.line(';; Got answer:');
        ctx.line(';; ->>HEADER<<- opcode: QUERY, status: ' + res.status + ', id: ' + U.randInt(1000, 65000));
        ctx.line(';; flags: qr rd ra' + (res.aa ? ' aa' : '') + '; QUERY: 1, ANSWER: ' + answers.length +
          ', AUTHORITY: ' + (res.authority ? 1 : 0) + ', ADDITIONAL: 1');
        ctx.line('');
        ctx.line(';; OPT PSEUDOSECTION:');
        ctx.line('; EDNS: version: 0, flags:; udp: 1232');
        ctx.line(';; QUESTION SECTION:');
        ctx.line(';' + name + '.\t\t\tIN\t' + type);
        ctx.line('');
        if (answers.length) {
          ctx.line(';; ANSWER SECTION:');
          answers.forEach(function (a) {
            ctx.line(U.padRight(a.name + '.', 24) + a.ttl + '\tIN\t' + a.type + '\t' + a.value);
          });
          ctx.line('');
        }
        if (res.authority) {
          ctx.line(';; AUTHORITY SECTION:');
          ctx.line(res.authority);
          ctx.line('');
        }
        ctx.line(';; Query time: ' + Math.max(0, Math.round(res.rtt || (Date.now() - start))) + ' msec');
        ctx.line(';; SERVER: ' + usedServer + '#53(' + usedServer + ') (UDP)');
        ctx.line(';; WHEN: ' + new Date().toString().slice(0, 24));
        ctx.line(';; MSG SIZE  rcvd: ' + (56 + answers.length * 16));
        ctx.line('');
        return res.status === 'NOERROR' ? 0 : 0;
      });
    }
  });

  reg({
    name: 'nslookup', category: 'dns', summary: 'простой DNS-запрос',
    usage: 'nslookup NAME [SERVER]', complete: nameComplete,
    run: function (ctx) {
      var name = ctx.argv[0];
      var server = ctx.argv[1];
      if (!name) return ctx.usageError('Usage: nslookup name [server]');
      var isRev = U.isIPv4(name);
      var res = isRev
        ? NET.dns.reverse(ctx.world, ctx.machine, name)
        : NET.dns.resolve(ctx.world, ctx.machine, name, { type: 'A', server: server });
      var used = server || res.server || (NET.dns.resolvers(ctx.machine)[0] || '127.0.0.53');
      var slow = res.status === 'TIMEOUT' || res.status === 'UNREACH';
      return ctx.sleep(slow ? 1000 : 60).then(function () {
        if (res.viaHosts) {
          ctx.line('Server:\t\t' + used);
          ctx.line('Address:\t' + used + '#53');
          ctx.line('');
          ctx.line('Name:\t' + name);
          ctx.line('Address: ' + res.ip);
          return 0;
        }
        if (res.status === 'NORESOLVER') { ctx.errLine(';; no servers could be reached'); return 1; }
        if (slow) {
          ctx.errLine(';; communications error to ' + used + '#53: timed out');
          ctx.errLine(';; no servers could be reached');
          return 1;
        }
        ctx.line('Server:\t\t' + used);
        ctx.line('Address:\t' + used + '#53');
        ctx.line('');
        if (res.status === 'NXDOMAIN') {
          ctx.line('** server can\'t find ' + name + ': NXDOMAIN');
          return 1;
        }
        if (res.status === 'SERVFAIL') {
          ctx.line('** server can\'t find ' + name + ': SERVFAIL');
          return 1;
        }
        if (!res.aa) ctx.line('Non-authoritative answer:');
        (res.answers || []).forEach(function (a) {
          if (a.type === 'CNAME') ctx.line(a.name + '\tcanonical name = ' + a.value);
          else if (a.type === 'PTR') ctx.line(a.name + '\tname = ' + a.value);
          else {
            ctx.line('Name:\t' + a.name);
            ctx.line('Address: ' + a.value);
          }
        });
        return 0;
      });
    }
  });

  reg({
    name: 'host', category: 'dns', summary: 'краткий DNS-запрос',
    usage: 'host NAME [SERVER]', complete: nameComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['t', 'a', 'v'] });
      var name = p.rest[0];
      var server = p.rest[1];
      if (!name) return ctx.usageError('Usage: host [-t type] name [server]');
      if (U.isIPv4(name)) {
        var rev = NET.dns.reverse(ctx.world, ctx.machine, name);
        return ctx.sleep(60).then(function () {
          if (rev.answers && rev.answers.length) {
            ctx.line(name + '.in-addr.arpa domain name pointer ' + rev.answers[0].value);
            return 0;
          }
          ctx.line('Host ' + name.split('.').reverse().join('.') + '.in-addr.arpa. not found: 3(NXDOMAIN)');
          return 1;
        });
      }
      var res = NET.dns.resolve(ctx.world, ctx.machine, name, { type: 'A', server: server });
      var slow = res.status === 'TIMEOUT' || res.status === 'UNREACH';
      return ctx.sleep(slow ? 1000 : 60).then(function () {
        if (res.status === 'NORESOLVER') { ctx.errLine('host: no servers could be reached'); return 1; }
        if (slow) { ctx.errLine(';; connection timed out; no servers could be reached'); return 1; }
        if (res.status === 'NXDOMAIN') { ctx.line('Host ' + name + ' not found: 3(NXDOMAIN)'); return 1; }
        if (res.status === 'SERVFAIL') { ctx.line('Host ' + name + ' not found: 2(SERVFAIL)'); return 1; }
        (res.answers || []).forEach(function (a) {
          if (a.type === 'A') ctx.line(a.name + ' has address ' + a.value);
          else if (a.type === 'AAAA') ctx.line(a.name + ' has IPv6 address ' + a.value);
          else if (a.type === 'CNAME') ctx.line(a.name + ' is an alias for ' + a.value);
          else if (a.type === 'MX') ctx.line(a.name + ' mail is handled by ' + a.value);
        });
        return 0;
      });
    }
  });

  reg({
    name: 'resolvectl', aliases: ['systemd-resolve'], category: 'dns',
    summary: 'состояние systemd-resolved', usage: 'resolvectl [status|query NAME|flush-caches]',
    run: function (ctx) {
      var sub = ctx.argv[0] || 'status';
      var m = ctx.machine;
      if (sub === 'query') {
        var name = ctx.argv[1];
        if (!name) return ctx.usageError('resolvectl: query requires a name');
        var res = NET.dns.resolve(ctx.world, m, name, { type: 'A' });
        return ctx.sleep(80).then(function () {
          if (!res.ip) {
            ctx.errLine(name + ': Temporary failure in name resolution');
            return 1;
          }
          ctx.line(name + ': ' + res.ip);
          ctx.line('');
          ctx.line('-- Information acquired via protocol DNS in ' + Math.round(res.rtt || 3) + 'ms.');
          ctx.line('-- Data from: network');
          return 0;
        });
      }
      if (sub === 'flush-caches') { ctx.line('Flushed caches.'); return 0; }
      if (sub === 'dns' || sub === 'status') {
        var active = m.services.isActive('systemd-resolved');
        ctx.line('Global');
        ctx.line('       Protocols: -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported');
        ctx.line('resolv.conf mode: ' + (active ? 'stub' : 'foreign'));
        if (!active) ctx.line('  (systemd-resolved НЕ активен — 127.0.0.53 никто не слушает)');
        ctx.line('');
        m.net.ifaces.forEach(function (i) {
          if (i.type === 'loopback') return;
          ctx.line('Link ' + i.index + ' (' + i.name + ')');
          ctx.line('    Current Scopes: ' + ((m.resolved.upstream || []).length ? 'DNS' : 'none'));
          ctx.line('         Protocols: +DefaultRoute -LLMNR -mDNS -DNSOverTLS');
          if ((m.resolved.upstream || []).length) {
            ctx.line('Current DNS Server: ' + m.resolved.upstream[0]);
            ctx.line('       DNS Servers: ' + m.resolved.upstream.join(' '));
          }
          if ((m.resolved.search || []).length) ctx.line('        DNS Domain: ' + m.resolved.search.join(' '));
          ctx.line('');
        });
        return 0;
      }
      return ctx.usageError('resolvectl: unknown command ' + sub);
    }
  });

  reg({
    name: 'getent', category: 'dns', summary: 'запрос к базам NSS',
    usage: 'getent hosts|passwd|group [KEY]',
    run: function (ctx) {
      var db = ctx.argv[0], key = ctx.argv[1];
      if (db === 'hosts') {
        if (!key) {
          try { ctx.out(ctx.vfs.read('/etc/hosts', ctx.fsctx)); } catch (e) {}
          return 0;
        }
        var res = NET.dns.resolve(ctx.world, ctx.machine, key, { type: 'A' });
        if (!res.ip) return 2;
        ctx.line(U.padRight(res.ip, 16) + key);
        return 0;
      }
      if (db === 'passwd') {
        var text = ctx.machine.users.passwdFile();
        if (key) {
          var line = text.split('\n').filter(function (l) { return l.indexOf(key + ':') === 0; })[0];
          if (!line) return 2;
          ctx.line(line);
          return 0;
        }
        ctx.out(text);
        return 0;
      }
      if (db === 'group') { ctx.out(ctx.machine.users.groupFile()); return 0; }
      return ctx.fail('getent: Unknown database: ' + db, 2);
    }
  });
})(window.NET);
