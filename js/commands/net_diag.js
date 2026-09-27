/*
 * net_diag.js — диагностика: ping, traceroute, tracepath, mtr, ss, netstat,
 * nc, telnet, curl, wget, arping.
 *
 * Вывод строится по результату packet.js, поэтому симптом всегда соответствует
 * реальной поломке в модели: DROP даёт таймаут, REJECT — connection refused,
 * ARP-сбой — Destination Host Unreachable, а MTU-blackhole — зависание.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var C = NET.cmdlib;
  var reg = NET.commands.register;
  var P = NET.packet;
  var E = NET.packet.E;
  var resolveTarget = C.resolveTarget;

  function addrComplete(ctx, word, argv, h) { return h.addrs(ctx); }

  /* ---------- ping ---------- */

  reg({
    name: 'ping', aliases: ['ping6'], category: 'net', summary: 'проверка доступности по ICMP',
    usage: 'ping [-c N] [-s SIZE] [-M do] [-I IFACE] [-W sec] [-n] HOST',
    complete: addrComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { value: ['c', 'i', 's', 'W', 'I', 'M', 't'], bool: ['n', '4', '6', 'q', 'D'] });
      var target = p.rest[0];
      if (!target) return ctx.usageError('Usage: ping [options] <destination>');

      var res = resolveTarget(ctx, target);
      if (res.err) {
        ctx.errLine('ping: ' + target + ': ' + (res.err === 'NXDOMAIN'
          ? 'Name or service not known' : 'Temporary failure in name resolution'));
        return 2;
      }
      var count = C.intArg(ctx, 'ping', p.opts.c, 4, { min: 1, max: U.LIMITS.loopCount });
      if (count === null) return 2;
      var size = C.intArg(ctx, 'ping', p.opts.s, 56, { min: 0, max: 65507, notify: false });
      if (size === null) return 2;
      var ttl = C.intArg(ctx, 'ping', p.opts.t, 64, { min: 1, max: 255, notify: false });
      if (ttl === null) return 2;
      var df = p.opts.M === 'do';
      var host = res.resolved ? res.name + ' (' + res.ip + ')' : res.ip;

      /* первая проба до заголовка: так ping ведёт себя при явной ошибке сокета */
      var probe = P.icmpEcho(ctx.world, ctx.machine, res.ip, { size: size, df: df, ttl: ttl });
      if (probe.error === E.NETUNREACH) {
        ctx.errLine('ping: connect: Network is unreachable');
        return 2;
      }
      if (probe.error === E.PERM) {
        ctx.errLine('ping: sendmsg: Operation not permitted');
        return 2;
      }
      if (probe.error === E.MSGSIZE) {
        ctx.line('PING ' + host + ' ' + size + '(' + (size + 28) + ') bytes of data.');
        ctx.errLine('ping: local error: message too long, mtu=' + probe.mtu);
        ctx.line('');
        ctx.line('--- ' + res.ip + ' ping statistics ---');
        ctx.line('1 packets transmitted, 0 received, +1 errors, 100% packet loss, time 0ms');
        return 1;
      }

      ctx.line('PING ' + host + ' ' + size + '(' + (size + 28) + ') bytes of data.');
      var sent = 0, recv = 0, errors = 0;
      var rtts = [];
      var start = Date.now();
      var seq = 1;
      var localIP = null;
      var lr = ctx.machine.net.lookupRoute(res.ip);
      if (lr) localIP = lr.src;

      function one() {
        if (seq > count || ctx.aborted()) return finish();
        var r = seq === 1 ? probe : P.icmpEcho(ctx.world, ctx.machine, res.ip, { size: size, df: df, ttl: ttl });
        sent++;
        if (r.ok) {
          recv++;
          var rtt = Math.max(0.03, r.rtt);
          rtts.push(rtt);
          var remoteTtl = 64 - Math.max(0, (r.hops.length - 1));
          ctx.line((size + 8) + ' bytes from ' + (p.flags.n || !res.resolved ? res.ip : res.name + ' (' + res.ip + ')') +
            ': icmp_seq=' + seq + ' ttl=' + remoteTtl + ' time=' + rtt.toFixed(1) + ' ms');
        } else if (r.error === E.HOSTUNREACH) {
          errors++;
          ctx.line('From ' + (localIP || '0.0.0.0') + ' icmp_seq=' + seq + ' Destination Host Unreachable');
        } else if (r.error === E.NETUNREACH) {
          errors++;
          ctx.line('From ' + (r.errorFrom || localIP) + ' icmp_seq=' + seq + ' Destination Net Unreachable');
        } else if (r.error === E.UNREACH_ADMIN) {
          errors++;
          ctx.line('From ' + (r.errorFrom || localIP) + ' icmp_seq=' + seq + ' Packet filtered');
        } else if (r.error === E.FRAGNEEDED) {
          errors++;
          ctx.line('From ' + (r.errorFrom || localIP) + ' icmp_seq=' + seq +
            ' Frag needed and DF set (mtu = ' + r.mtu + ')');
        } else if (r.error === E.TTL) {
          errors++;
          ctx.line('From ' + (r.errorFrom || '?') + ' icmp_seq=' + seq + ' Time to live exceeded');
        }
        seq++;
        return ctx.sleep(seq > count ? 120 : 620).then(one);
      }

      function finish() {
        NET.bus.emit('probe:result', {
          from: ctx.machine.name, ip: res.ip, ok: recv > 0, kind: 'icmp'
        });
        var elapsed = Math.max(1, Date.now() - start);
        ctx.line('');
        ctx.line('--- ' + (res.resolved ? res.name : res.ip) + ' ping statistics ---');
        var loss = sent ? Math.round((sent - recv) / sent * 100) : 100;
        ctx.line(sent + ' packets transmitted, ' + recv + ' received, ' +
          (errors ? '+' + errors + ' errors, ' : '') + loss + '% packet loss, time ' + elapsed + 'ms');
        if (rtts.length) {
          var min = Math.min.apply(null, rtts), max = Math.max.apply(null, rtts);
          var avg = rtts.reduce(function (a, b) { return a + b; }, 0) / rtts.length;
          var mdev = Math.sqrt(rtts.reduce(function (a, b) { return a + Math.pow(b - avg, 2); }, 0) / rtts.length);
          ctx.line('rtt min/avg/max/mdev = ' + min.toFixed(3) + '/' + avg.toFixed(3) + '/' +
            max.toFixed(3) + '/' + mdev.toFixed(3) + ' ms');
        }
        return recv > 0 ? 0 : 1;
      }

      return one();
    }
  });

  /* ---------- traceroute / tracepath / mtr ---------- */

  reg({
    name: 'traceroute', category: 'net', summary: 'путь до узла',
    usage: 'traceroute [-n] [-I] [-m N] HOST', complete: addrComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['n', 'I', '4', '6'], value: ['m', 'w', 'q'] });
      var target = p.rest[0];
      if (!target) return ctx.usageError('Usage: traceroute [options] host');
      var res = resolveTarget(ctx, target);
      if (res.err) return ctx.fail('traceroute: unknown host ' + target, 2);

      var maxTtl = C.intArg(ctx, 'traceroute', p.opts.m, 30, { min: 1, max: 40 });
      if (maxTtl === null) return 2;
      ctx.line('traceroute to ' + res.name + ' (' + res.ip + '), ' +
        maxTtl + ' hops max, 60 byte packets');
      var tr = P.traceroute(ctx.world, ctx.machine, res.ip, {
        maxTtl: maxTtl, icmp: p.flags.I, probes: 3
      });
      var idx = 0;
      function step() {
        if (idx >= tr.hops.length || ctx.aborted()) {
          if (tr.fatal === E.NETUNREACH) ctx.errLine('connect: Network is unreachable');
          if (tr.fatal === E.HOSTUNREACH) ctx.errLine('connect: No route to host');
          return tr.reached ? 0 : (tr.fatal ? 2 : 0);
        }
        var h = tr.hops[idx];
        var line = U.pad(h.ttl, 2) + '  ';
        var lastIp = null;
        h.probes.forEach(function (pr) {
          if (!pr) { line += ' *'; return; }
          if (pr.ip !== lastIp) {
            var nm = p.flags.n ? pr.ip : (C.reverseName(ctx, pr.ip) || pr.ip);
            line += (lastIp ? '  ' : '') + nm + ' (' + pr.ip + ') ';
            lastIp = pr.ip;
          }
          line += ' ' + pr.rtt.toFixed(3) + ' ms' + (pr.note ? ' ' + pr.note : '');
        });
        ctx.line(line);
        idx++;
        return ctx.sleep(200).then(step);
      }
      return step();
    }
  });

  reg({
    name: 'tracepath', category: 'net', summary: 'путь и MTU до узла',
    usage: 'tracepath [-n] HOST', complete: addrComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['n', '4', '6'] });
      var target = p.rest[0];
      if (!target) return ctx.usageError('Usage: tracepath [-n] <destination>');
      var res = resolveTarget(ctx, target);
      if (res.err) return ctx.fail('tracepath: unknown host ' + target, 2);

      var lr = ctx.machine.net.lookupRoute(res.ip);
      var localMtu = lr && lr.iface ? lr.iface.mtu : 1500;
      ctx.line(' 1?: [LOCALHOST]                      pmtu ' + localMtu);

      var pmtu = localMtu;
      var hops = P.traceroute(ctx.world, ctx.machine, res.ip, { icmp: false, probes: 1, maxTtl: 12 });
      var idx = 0;
      function step() {
        if (idx >= hops.hops.length || ctx.aborted()) {
          /* проверяем реальный путь большим пакетом с DF */
          var big = P.icmpEcho(ctx.world, ctx.machine, res.ip, { size: pmtu - 28, df: true });
          if (big.error === E.FRAGNEEDED && big.mtu) pmtu = big.mtu;
          if (big.error === E.BLACKHOLE) {
            ctx.line('     Too many hops: pmtu ' + pmtu);
            ctx.line('     Resume: pmtu ' + pmtu);
            return 1;
          }
          ctx.line('     Resume: pmtu ' + pmtu + ' hops ' + hops.hops.length + ' back ' + hops.hops.length);
          return 0;
        }
        var h = hops.hops[idx];
        var pr = h.probes[0];
        if (!pr) ctx.line(U.pad(h.ttl, 2) + ':  no reply');
        else {
          var nm = p.flags.n ? pr.ip : (C.reverseName(ctx, pr.ip) || pr.ip);
          ctx.line(U.pad(h.ttl, 2) + ':  ' + U.padRight(nm, 36) + pr.rtt.toFixed(3) + 'ms' +
            (idx === hops.hops.length - 1 && hops.reached ? ' reached' : ''));
        }
        idx++;
        return ctx.sleep(150).then(step);
      }
      return step();
    }
  });

  reg({
    name: 'mtr', category: 'net', summary: 'traceroute + статистика',
    usage: 'mtr --report [-n] HOST', complete: addrComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['n', 'report', 'r'], value: ['c'] });
      var target = p.rest[0];
      if (!target) return ctx.usageError('mtr: no hostname specified');
      var res = resolveTarget(ctx, target);
      if (res.err) return ctx.fail('mtr: Failed to resolve host: ' + target, 1);
      var cycles = C.count(p.opts.c, 10, 100);
      ctx.line('Start: ' + new Date().toISOString().slice(0, 19).replace('T', ' '));
      ctx.line('HOST: ' + U.padRight(ctx.machine.hostname, 28) + 'Loss%   Snt   Last   Avg  Best  Wrst StDev');
      var tr = P.traceroute(ctx.world, ctx.machine, res.ip, { probes: 3, maxTtl: 15 });
      tr.hops.forEach(function (h, i) {
        var good = h.probes.filter(Boolean);
        var loss = Math.round((h.probes.length - good.length) / h.probes.length * 100);
        var rtts = good.map(function (g) { return g.rtt; });
        var avg = rtts.length ? rtts.reduce(function (a, b) { return a + b; }, 0) / rtts.length : 0;
        var ip = good.length ? good[0].ip : '???';
        var nm = p.flags.n ? ip : (C.reverseName(ctx, ip) || ip);
        ctx.line('  ' + U.pad(i + 1, 2) + '.|-- ' + U.padRight(nm, 24) +
          U.pad(loss + '.0%', 6) + U.pad(cycles, 6) +
          U.pad(avg.toFixed(1), 7) + U.pad(avg.toFixed(1), 6) +
          U.pad((avg * 0.9).toFixed(1), 6) + U.pad((avg * 1.3).toFixed(1), 6) +
          U.pad((avg * 0.08).toFixed(1), 6));
      });
      return 0;
    }
  });

  /* ---------- ss / netstat ---------- */

  function socketRows(ctx, opts) {
    var rows = [];
    ctx.machine.net.sockets.forEach(function (s) {
      if (opts.listening && s.state !== 'LISTEN') return;
      if (!opts.listening && !opts.all && s.state === 'LISTEN') return;
      if (opts.tcp && !opts.udp && s.proto !== 'tcp') return;
      if (opts.udp && !opts.tcp && s.proto !== 'udp') return;
      if (!opts.tcp && !opts.udp && opts.filterProto && s.proto !== opts.filterProto) return;
      rows.push(s);
    });
    return rows;
  }

  reg({
    name: 'ss', category: 'net', summary: 'сокеты: кто слушает и кто подключён',
    usage: 'ss [-t] [-u] [-l] [-n] [-p] [-a] [-s]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['t', 'u', 'l', 'n', 'p', 'a', 's', 'x', '4', '6', 'e', 'i', 'm', 'o'] });
      if (p.flags.s) {
        var total = ctx.machine.net.sockets.length;
        ctx.line('Total: ' + (total + 12));
        ctx.line('TCP:   ' + ctx.machine.net.sockets.filter(function (s) { return s.proto === 'tcp'; }).length +
          ' (estab ' + ctx.machine.net.sockets.filter(function (s) { return s.state === 'ESTAB'; }).length +
          ', closed 0, orphaned 0, timewait 0)');
        ctx.line('');
        ctx.line('Transport Total     IP        IPv6');
        ctx.line('RAW\t  1         0         1');
        ctx.line('UDP\t  ' + ctx.machine.net.sockets.filter(function (s) { return s.proto === 'udp'; }).length + '         2         1');
        ctx.line('TCP\t  ' + ctx.machine.net.sockets.filter(function (s) { return s.proto === 'tcp'; }).length + '         3         2');
        return 0;
      }
      var rows = socketRows(ctx, { tcp: p.flags.t, udp: p.flags.u, listening: p.flags.l, all: p.flags.a });
      var showProc = p.flags.p;
      ctx.line(U.padRight('Netid', 6) + U.padRight('State', 8) + U.pad('Recv-Q', 7) + U.pad('Send-Q', 7) + ' ' +
        U.padRight('Local Address:Port', 30) + U.padRight('Peer Address:Port', 24) + (showProc ? 'Process' : ''));
      rows.forEach(function (s) {
        var local = (s.addr === '0.0.0.0' && p.flags.n ? '0.0.0.0' : s.addr) + ':' + s.port;
        var peer = s.state === 'LISTEN' ? '0.0.0.0:*' : s.peerAddr + ':' + s.peerPort;
        var proc = '';
        if (showProc && s.process) {
          proc = ctx.isRoot
            ? 'users:(("' + s.process + '",pid=' + (s.pid || 1) + ',fd=3))'
            : '';
        }
        ctx.line(U.padRight(s.proto, 6) + U.padRight(s.state, 8) + U.pad(0, 7) +
          U.pad(s.state === 'LISTEN' ? 128 : 0, 7) + ' ' +
          U.padRight(local, 30) + U.padRight(peer, 24) + proc);
      });
      if (showProc && !ctx.isRoot) {
        ctx.errLine('Cannot open netlink socket: Operation not permitted (запустите через sudo, чтобы видеть процессы)');
      }
      return 0;
    }
  });

  reg({
    name: 'netstat', category: 'net', summary: 'устаревший аналог ss',
    usage: 'netstat [-tulpn] [-r] [-i]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['t', 'u', 'l', 'p', 'n', 'a', 'r', 'i', 's'] });
      if (p.flags.r) return NET.shell.invokeAs(ctx, ['route', '-n'], ctx.user);
      if (p.flags.i) {
        ctx.line('Kernel Interface table');
        ctx.line(U.padRight('Iface', 10) + U.pad('MTU', 6) + U.pad('RX-OK', 10) + U.pad('RX-ERR', 8) +
          U.pad('TX-OK', 10) + U.pad('TX-ERR', 8) + ' Flg');
        ctx.machine.net.ifaces.forEach(function (i) {
          ctx.line(U.padRight(i.name, 10) + U.pad(i.mtu, 6) + U.pad(i.stats.rxPackets, 10) +
            U.pad(i.stats.rxErrors, 8) + U.pad(i.stats.txPackets, 10) + U.pad(i.stats.txErrors, 8) +
            ' ' + (i.state === 'UP' ? 'BMRU' : 'BM'));
        });
        return 0;
      }
      var rows = socketRows(ctx, { tcp: p.flags.t, udp: p.flags.u, listening: p.flags.l, all: p.flags.a });
      ctx.line('Active Internet connections (' + (p.flags.l ? 'only servers' : 'servers and established') + ')');
      ctx.line(U.padRight('Proto', 7) + U.pad('Recv-Q', 7) + U.pad('Send-Q', 7) + ' ' +
        U.padRight('Local Address', 24) + U.padRight('Foreign Address', 24) + U.padRight('State', 13) +
        (p.flags.p ? 'PID/Program name' : ''));
      rows.forEach(function (s) {
        ctx.line(U.padRight(s.proto, 7) + U.pad(0, 7) + U.pad(0, 7) + ' ' +
          U.padRight(s.addr + ':' + s.port, 24) +
          U.padRight(s.state === 'LISTEN' ? '0.0.0.0:*' : s.peerAddr + ':' + s.peerPort, 24) +
          U.padRight(s.state === 'ESTAB' ? 'ESTABLISHED' : s.state, 13) +
          (p.flags.p && ctx.isRoot && s.process ? (s.pid || '-') + '/' + s.process : ''));
      });
      return 0;
    }
  });

  /* ---------- nc / telnet ---------- */

  function connectReport(ctx, host, ip, port, r) {
    return r.ok ? null : C.connectErrorText(r.error);
  }

  reg({
    name: 'nc', aliases: ['netcat'], category: 'net', summary: 'проверка TCP/UDP порта',
    usage: 'nc -zv HOST PORT', complete: addrComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['z', 'v', 'u', 'l', 'n'], value: ['w', 'p'] });
      var host = p.rest[0];
      var port = U.portNumber(p.rest[1]);
      if (!host || !port || port < 1 || port > 65535) {
        return ctx.usageError('usage: nc [-46CDdFhklNnrStUuvZz] [-w timeout] destination port');
      }
      var res = resolveTarget(ctx, host);
      if (res.err) return ctx.fail('nc: getaddrinfo for host "' + host + '" port ' + port + ': Name or service not known', 1);

      var delayed = p.flags.u
        ? P.udpSend(ctx.world, ctx.machine, res.ip, port, {})
        : P.tcpConnect(ctx.world, ctx.machine, res.ip, port, {});

      var wait = delayed.error === E.TIMEOUT || delayed.error === E.BLACKHOLE ? 1200 : 80;
      return ctx.sleep(wait).then(function () {
        NET.bus.emit('probe:result', {
          from: ctx.machine.name, ip: res.ip, ok: !!delayed.ok, kind: 'tcp', port: port
        });
        if (delayed.ok) {
          var svcName = portService(port);
          if (p.flags.v) {
            ctx.errLine('Connection to ' + res.ip + ' ' + port + ' port [' + (p.flags.u ? 'udp' : 'tcp') +
              '/' + svcName + '] succeeded!');
          }
          return 0;
        }
        var reason = connectReport(ctx, host, res.ip, port, delayed);
        if (p.flags.v || true) {
          ctx.errLine('nc: connect to ' + host + ' (' + res.ip + ') port ' + port + ' (' +
            (p.flags.u ? 'udp' : 'tcp') + ') failed: ' + reason);
        }
        return 1;
      });
    }
  });

  function portService(port) { return U.portName(port); }

  reg({
    name: 'telnet', category: 'net', summary: 'проверка TCP-порта вручную',
    usage: 'telnet HOST PORT', complete: addrComplete,
    run: function (ctx) {
      var host = ctx.argv[0];
      var port = U.clampInt(ctx.argv[1], 23, 1, 65535);
      if (!host) return ctx.usageError('usage: telnet host [port]');
      var res = resolveTarget(ctx, host);
      if (res.err) return ctx.fail('telnet: could not resolve ' + host + '/' + port + ': Name or service not known', 1);
      ctx.line('Trying ' + res.ip + '...');
      var r = P.tcpConnect(ctx.world, ctx.machine, res.ip, port, {});
      return ctx.sleep(r.ok ? 120 : 900).then(function () {
        if (r.ok) {
          ctx.line('Connected to ' + host + '.');
          ctx.line('Escape character is \'^]\'.');
          ctx.line('^C');
          ctx.line('Connection closed by foreign host.');
          return 0;
        }
        ctx.line('telnet: Unable to connect to remote host: ' + connectReport(ctx, host, res.ip, port, r));
        return 1;
      });
    }
  });

  /* ---------- curl / wget ---------- */

  function httpFetch(ctx, url, opts) {
    opts = opts || {};
    var m = String(url).match(/^(?:(https?):\/\/)?([^\/:]+)(?::(\d+))?(\/.*)?$/);
    if (!m) return { err: 'malformed', code: 3 };
    var scheme = m[1] || 'http';
    var host = m[2];
    var port = m[3] ? Number(m[3]) : (scheme === 'https' ? 443 : 80);
    var path = m[4] || '/';

    var res = resolveTarget(ctx, host);
    if (res.err) return { err: 'resolve', host: host, code: 6 };

    var tcp = P.tcpConnect(ctx.world, ctx.machine, res.ip, port, {});
    if (!tcp.ok) return { err: 'connect', ip: res.ip, host: host, port: port, net: tcp, code: tcp.error === E.REFUSED ? 7 : 28 };

    var node = tcp.dst.machine;
    var unit = node.services.byPort(port, 'tcp');
    if (unit && unit.state !== 'active') return { err: 'connect', ip: res.ip, host: host, port: port, net: { error: E.REFUSED }, code: 7 };

    var pages = node.http || {};
    var page = pages[path];
    if (!page) {
      var nodePath = path.replace(/\/$/, '');
      page = pages[nodePath] || null;
    }
    if (!page && path === '/') {
      try {
        var body = node.vfs.read('/var/www/html/index.html', NET.ROOTCTX);
        page = { status: 200, body: body };
      } catch (e) { page = null; }
    }
    if (!page) return { status: 404, host: host, ip: res.ip, port: port, body: '<html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>\n', server: 'nginx/1.24.0' };

    /* большой ответ проверяет MTU по пути: тут и всплывает blackhole */
    var size = page.size || page.body.length;
    if (size > 1200) {
      var lr = ctx.machine.net.lookupRoute(res.ip);
      var probeSize = Math.min(1500, lr && lr.iface ? lr.iface.mtu : 1500);
      var big = P.send(ctx.world, ctx.machine, res.ip, {
        proto: 'tcp', dport: port, sport: tcp.sport, size: probeSize, df: true, ct: 'ESTABLISHED'
      });
      if (big.error === E.BLACKHOLE || big.error === E.FRAGNEEDED) {
        return { err: 'stall', host: host, ip: res.ip, port: port, code: 28, mtu: big.mtu };
      }
    }
    return {
      status: page.status || 200, body: page.body, host: host, ip: res.ip, port: port,
      size: size, server: 'nginx/1.24.0', scheme: scheme
    };
  }

  reg({
    name: 'curl', category: 'net', summary: 'HTTP-запрос',
    usage: 'curl [-I] [-v] [-s] [-4] [--max-time N] URL', complete: addrComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['I', 'v', 's', 'S', 'L', 'k', '4', '6', 'f'], value: ['o', 'max-time', 'connect-timeout', 'H', 'X', 'resolve'] });
      var url = p.rest[0];
      if (!url) {
        ctx.errLine('curl: try \'curl --help\' for more information');
        return 2;
      }
      var r = httpFetch(ctx, url, p);
      var slow = (r.err === 'connect' && r.code === 28) || r.err === 'stall';
      return ctx.sleep(slow ? 1400 : 120).then(function () {
        NET.bus.emit('probe:result', {
          from: ctx.machine.name, ip: r.ip || null, ok: !r.err, kind: 'http', port: r.port
        });
        if (r.err === 'resolve') {
          ctx.errLine('curl: (6) Could not resolve host: ' + r.host);
          return 6;
        }
        if (r.err === 'connect') {
          var why = connectReport(ctx, r.host, r.ip, r.port, r.net);
          ctx.errLine('curl: (' + r.code + ') Failed to connect to ' + r.host + ' port ' + r.port +
            ' after ' + (r.code === 7 ? '2' : '3004') + ' ms: ' + why);
          return r.code;
        }
        if (r.err === 'stall') {
          ctx.errLine('curl: (28) Operation timed out after 5001 milliseconds with 0 out of ' +
            (r.size || 65536) + ' bytes received');
          return 28;
        }
        if (p.flags.v) {
          ctx.errLine('*   Trying ' + r.ip + ':' + r.port + '...');
          ctx.errLine('* Connected to ' + r.host + ' (' + r.ip + ') port ' + r.port);
          ctx.errLine('> GET / HTTP/1.1');
          ctx.errLine('> Host: ' + r.host);
          ctx.errLine('> User-Agent: curl/8.5.0');
          ctx.errLine('>');
          ctx.errLine('< HTTP/1.1 ' + r.status + (r.status === 200 ? ' OK' : ' Not Found'));
        }
        if (p.flags.I) {
          ctx.line('HTTP/1.1 ' + r.status + (r.status === 200 ? ' OK' : ' Not Found'));
          ctx.line('Server: ' + r.server);
          ctx.line('Date: ' + new Date().toUTCString());
          ctx.line('Content-Type: text/html');
          ctx.line('Content-Length: ' + (r.size || r.body.length));
          ctx.line('Connection: keep-alive');
          ctx.line('');
          return 0;
        }
        if (p.opts.o) {
          try { ctx.vfs.write(ctx.resolve(p.opts.o), r.body, ctx.fsctx); } catch (e) {}
          return 0;
        }
        ctx.out(r.body);
        return r.status === 200 ? 0 : (p.flags.f ? 22 : 0);
      });
    }
  });

  reg({
    name: 'wget', category: 'net', summary: 'скачать по HTTP',
    usage: 'wget [-O FILE] [-q] URL', complete: addrComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['q', 'S'], value: ['O', 'T', 'timeout'] });
      var url = p.rest[0];
      if (!url) return ctx.usageError('wget: missing URL');
      var r = httpFetch(ctx, url, p);
      var stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
      var slow = (r.err === 'connect' && r.code === 28) || r.err === 'stall';
      return ctx.sleep(slow ? 1400 : 150).then(function () {
        if (r.err === 'resolve') {
          ctx.errLine('--' + stamp + '--  ' + url);
          ctx.errLine('Resolving ' + r.host + ' (' + r.host + ')... failed: Temporary failure in name resolution.');
          ctx.errLine('wget: unable to resolve host address ‘' + r.host + '’');
          return 4;
        }
        if (r.err === 'connect' || r.err === 'stall') {
          ctx.errLine('--' + stamp + '--  ' + url);
          ctx.errLine('Connecting to ' + r.host + '|' + r.ip + '|:' + r.port + '... failed: ' +
            (r.err === 'stall' ? 'Connection timed out' : connectReport(ctx, r.host, r.ip, r.port, r.net)) + '.');
          ctx.errLine('Retrying.');
          return 4;
        }
        var file = p.opts.O || (url.replace(/\/$/, '').split('/').pop() || 'index.html');
        ctx.errLine('--' + stamp + '--  ' + url);
        ctx.errLine('Resolving ' + r.host + '... ' + r.ip);
        ctx.errLine('Connecting to ' + r.host + '|' + r.ip + '|:' + r.port + '... connected.');
        ctx.errLine('HTTP request sent, awaiting response... ' + r.status + (r.status === 200 ? ' OK' : ' Not Found'));
        ctx.errLine('Length: ' + (r.size || r.body.length) + ' [text/html]');
        ctx.errLine('Saving to: ‘' + file + '’');
        ctx.errLine('');
        ctx.errLine('‘' + file + '’ saved [' + (r.size || r.body.length) + ']');
        if (file !== '-') {
          try { ctx.vfs.write(ctx.resolve(file), r.body, ctx.fsctx); } catch (e) {}
        } else ctx.out(r.body);
        return 0;
      });
    }
  });

  /* ---------- arping ---------- */

  reg({
    name: 'arping', category: 'net', summary: 'ARP-проверка адреса (поиск конфликтов)',
    usage: 'arping [-I IFACE] [-c N] [-D] IP',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['D', 'f'], value: ['I', 'c', 'w'] });
      var ip = p.rest[0];
      if (!ip) return ctx.usageError('Usage: arping [-I interface] [-c count] destination');
      var net = ctx.machine.net;
      var iface = p.opts.I ? net.getIface(p.opts.I) : (net.lookupRoute(ip) || {}).iface;
      if (!iface) return ctx.fail('arping: Device ' + (p.opts.I || '?') + ' not available.', 2);
      if (!net.operational(iface)) return ctx.fail('arping: Device ' + iface.name + ' is down', 2);
      var seg = P.effSegment(ctx.machine, iface);
      var owners = P.ownersOnSegment(ctx.world, seg, ip, ctx.machine);
      var count = C.intArg(ctx, 'arping', p.opts.c, 3, { min: 1, max: U.LIMITS.loopCount });
      if (count === null) return 2;
      var src = (iface.addrs.filter(function (a) { return a.family === 4; })[0] || {}).ip || '0.0.0.0';
      ctx.line('ARPING ' + ip + ' from ' + src + ' ' + iface.name);
      var i = 0;
      function step() {
        if (i >= count || ctx.aborted()) {
          ctx.line('Sent ' + i + ' probes (' + i + ' broadcast(s))');
          ctx.line('Received ' + (owners.length * i) + ' response(s)' +
            (owners.length > 1 ? '  <<< ОБНАРУЖЕН КОНФЛИКТ: адрес занят несколькими хостами' : ''));
          return owners.length ? 0 : 1;
        }
        owners.forEach(function (o) {
          ctx.line('Unicast reply from ' + ip + ' [' + o.iface.mac + ']  ' +
            (0.6 + Math.random()).toFixed(3) + 'ms');
        });
        i++;
        return ctx.sleep(400).then(step);
      }
      return step();
    }
  });

  NET.httpFetch = httpFetch;
})(window.NET);
