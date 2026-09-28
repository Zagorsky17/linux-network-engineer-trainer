/*
 * net_ip.js — iproute2 (ip addr/link/route/neigh/rule) и legacy-утилиты
 * ifconfig/route/arp. Все они читают и меняют одно состояние netstack.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;

  function needRoot(ctx, what) {
    if (ctx.isRoot) return false;
    ctx.errLine('RTNETLINK answers: Operation not permitted');
    return true;
  }

  function flagsOf(i) {
    var f = [];
    if (i.type === 'loopback') f.push('LOOPBACK');
    else f.push('BROADCAST', 'MULTICAST');
    if (i.master) f.push('SLAVE');
    if (i.state === 'UP') f.push('UP');
    if (i.carrier && i.state === 'UP') f.push('LOWER_UP');
    if (!i.carrier) f.push('NO-CARRIER');
    return '<' + f.join(',') + '>';
  }

  function operState(i) {
    if (i.type === 'loopback') return 'UNKNOWN';
    if (!i.carrier) return 'DOWN';
    return i.state === 'UP' ? 'UP' : 'DOWN';
  }

  function linkLine(ctx, i) {
    var extra = '';
    if (i.master) extra += ' master ' + i.master;
    if (i.type === 'vlan' && i.link) extra = ' ' + extra;
    var qdisc = i.state === 'UP' ? (i.type === 'loopback' ? 'noqueue' : 'fq_codel') : 'noop';
    var head = i.index + ': ' + i.name + (i.type === 'vlan' && i.link ? '@' + i.link : '') +
      ': ' + flagsOf(i) + ' mtu ' + i.mtu + ' qdisc ' + qdisc + extra +
      ' state ' + operState(i) + ' group default qlen ' + i.txqueuelen;
    ctx.line(head);
    var kind = i.type === 'loopback' ? 'loopback' : 'ether';
    ctx.line('    link/' + kind + ' ' + i.mac + ' brd ' +
      (i.type === 'loopback' ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff'));
    if (i.type === 'vlan') ctx.line('    vlan protocol 802.1Q id ' + i.vlanId + ' <REORDER_HDR>');
    if (i.type === 'bond') ctx.line('    bond mode ' + (i.bondMode || 'balance-rr') + ' slaves: ' + (i.slaves.join(' ') || '-'));
  }

  /* ядро печатает inet до inet6 — сохраняем тот же порядок */
  function sortedAddrs(i) {
    return i.addrs.slice().sort(function (a, b) { return a.family - b.family; });
  }

  function addrLines(ctx, i, family) {
    sortedAddrs(i).forEach(function (a) {
      if (family && a.family !== family) return;
      if (a.family === 4) {
        var brd = a.prefix < 31 ? ' brd ' + U.broadcast(a.ip, a.prefix) : '';
        ctx.line('    inet ' + a.ip + '/' + a.prefix + brd + ' scope ' + a.scope + ' ' + (a.label || i.name) +
          (a.dynamic ? '' : ''));
        ctx.line('       valid_lft ' + (a.validLft ? a.validLft + 'sec' : 'forever') +
          ' preferred_lft ' + (a.validLft ? Math.floor(a.validLft / 2) + 'sec' : 'forever'));
      } else {
        ctx.line('    inet6 ' + a.ip + '/' + a.prefix + ' scope ' + a.scope +
          (a.scope === 'link' ? ' noprefixroute' : ''));
        ctx.line('       valid_lft forever preferred_lft forever');
      }
    });
  }

  function briefAddr(ctx, i, family) {
    var list = sortedAddrs(i).filter(function (a) { return !family || a.family === family; })
      .map(function (a) { return a.ip + '/' + a.prefix; });
    ctx.line(U.padRight(i.name, 16) + U.padRight(operState(i), 15) + list.join(' '));
  }

  function routeLine(ctx, r, net) {
    var s = '';
    if (r.prefix === 0) s += 'default';
    else s += r.dst + '/' + r.prefix;
    if (r.gw) s += ' via ' + r.gw;
    if (r.dev) s += ' dev ' + r.dev;
    if (r.proto && r.proto !== 'boot') s += ' proto ' + r.proto;
    if (r.scope && r.scope !== 'global') s += ' scope ' + r.scope;
    if (r.src) s += ' src ' + r.src;
    if (r.metric) s += ' metric ' + r.metric;
    if (r.onlink) s += ' onlink';
    var dev = r.dev ? net.getIface(r.dev) : null;
    if (dev && !net.operational(dev)) s += ' linkdown';
    ctx.line(s);
  }

  reg({
    name: 'ip', category: 'net', summary: 'интерфейсы, адреса, маршруты, ARP',
    usage: 'ip [-4|-6|-br|-s] { addr | link | route | neigh | rule } [ COMMAND ]',
    complete: function (ctx, word, argv, h) {
      var objs = ['addr', 'link', 'route', 'neigh', 'rule', 'a', 'r', 'l', 'n', '-br', '-4', '-6', '-s'];
      var real = argv.slice(1).filter(function (a) { return a[0] !== '-'; });
      if (!real.length) return objs;
      var obj = real[0];
      if (real.length === 1) {
        if (/^a/.test(obj)) return ['show', 'add', 'del', 'flush'];
        if (/^l/.test(obj)) return ['show', 'set', 'add', 'del'];
        if (/^r/.test(obj)) return ['show', 'add', 'del', 'get', 'flush'];
        if (/^n/.test(obj)) return ['show', 'flush', 'del'];
      }
      return h.ifaces(ctx).concat(['dev', 'via', 'default', 'up', 'down', 'mtu', 'master']);
    },
    run: function (ctx) {
      var argv = ctx.argv.slice();
      var family = null, brief = false, stats = false, color = false;
      while (argv.length && argv[0][0] === '-') {
        var f = argv.shift();
        if (f === '-4') family = 4;
        else if (f === '-6') family = 6;
        else if (f === '-br' || f === '-brief') brief = true;
        else if (f === '-s' || f === '-stats') stats = true;
        else if (f === '-c' || f === '-color') color = true;
        else if (f === '-h' || f === '-help') { usage(ctx); return 0; }
      }
      if (!argv.length) { usage(ctx); return 0; }

      var net = ctx.machine.net;
      var obj = argv.shift();
      var cmd = argv[0] && /^(show|list|add|del|delete|set|get|flush|replace|change|help)$/.test(argv[0])
        ? argv.shift() : 'show';

      if (/^(a|addr|address)$/.test(obj)) return ipAddr(ctx, net, cmd, argv, family, brief);
      if (/^(l|link)$/.test(obj)) return ipLink(ctx, net, cmd, argv, brief, stats);
      if (/^(r|route)$/.test(obj)) return ipRoute(ctx, net, cmd, argv, family);
      if (/^(n|neigh|neighbour|neighbor)$/.test(obj)) return ipNeigh(ctx, net, cmd, argv);
      if (/^(ru|rule)$/.test(obj)) return ipRule(ctx, net, cmd, argv);
      ctx.errLine('Object "' + obj + '" is unknown, try "ip help".');
      return 1;
    }
  });

  function usage(ctx) {
    ctx.line('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }');
    ctx.line('where  OBJECT := { address | link | route | neigh | rule }');
    ctx.line('       OPTIONS := { -4 | -6 | -br[ief] | -s[tatistics] | -c[olor] }');
  }

  /* ---------- ip addr ---------- */

  function ipAddr(ctx, net, cmd, argv, family, brief) {
    if (cmd === 'show' || cmd === 'list') {
      var dev = null;
      for (var i = 0; i < argv.length; i++) {
        if (argv[i] === 'dev') dev = argv[i + 1];
        else if (argv[i] !== 'up' && !dev && argv[i][0] !== '-') dev = argv[i];
      }
      var list = net.ifaces.filter(function (x) { return !dev || x.name === dev; });
      if (dev && !list.length) {
        ctx.errLine('Device "' + dev + '" does not exist.');
        return 1;
      }
      list.forEach(function (x) {
        if (brief) { briefAddr(ctx, x, family); return; }
        linkLine(ctx, x);
        addrLines(ctx, x, family);
      });
      return 0;
    }

    if (cmd === 'add' || cmd === 'del' || cmd === 'delete') {
      if (needRoot(ctx)) return 2;
      var cidr = argv[0];
      var devIdx = argv.indexOf('dev');
      var dev2 = devIdx >= 0 ? argv[devIdx + 1] : null;
      if (!cidr || !dev2) {
        ctx.errLine('Command line is not complete. Try option "help"');
        return 1;
      }
      if (!net.getIface(dev2)) { ctx.errLine('Cannot find device "' + dev2 + '"'); return 1; }
      var r = (cmd === 'add') ? net.addAddr(dev2, cidr, {}) : net.delAddr(dev2, cidr);
      if (r.err) { ctx.errLine(r.err); return 2; }
      ctx.machine.log('kernel', dev2 + ': address ' + (cmd === 'add' ? 'added ' : 'removed ') + cidr);
      return 0;
    }

    if (cmd === 'flush') {
      if (needRoot(ctx)) return 2;
      var di = argv.indexOf('dev');
      var d = di >= 0 ? argv[di + 1] : argv[0];
      if (!d || !net.getIface(d)) { ctx.errLine('Cannot find device "' + d + '"'); return 1; }
      net.flushAddrs(d);
      return 0;
    }
    ctx.errLine('Command "' + cmd + '" is unknown, try "ip address help".');
    return 1;
  }

  /* ---------- ip link ---------- */

  function ipLink(ctx, net, cmd, argv, brief, stats) {
    if (cmd === 'show' || cmd === 'list') {
      var dev = null;
      for (var i = 0; i < argv.length; i++) {
        if (argv[i] === 'dev') dev = argv[i + 1];
        else if (!dev && argv[i][0] !== '-') dev = argv[i];
      }
      var list = net.ifaces.filter(function (x) { return !dev || x.name === dev; });
      if (dev && !list.length) { ctx.errLine('Device "' + dev + '" does not exist.'); return 1; }
      list.forEach(function (x) {
        if (brief) {
          ctx.line(U.padRight(x.name, 16) + U.padRight(operState(x), 15) + U.padRight(x.mac, 20) + flagsOf(x));
          return;
        }
        linkLine(ctx, x);
        if (stats) {
          ctx.line('    RX: bytes  packets  errors  dropped missed  mcast');
          ctx.line('    ' + U.pad(x.stats.rxBytes, 10) + U.pad(x.stats.rxPackets, 9) +
            U.pad(x.stats.rxErrors, 8) + U.pad(x.stats.rxDropped, 8) + '      0      0');
          ctx.line('    TX: bytes  packets  errors  dropped carrier collsns');
          ctx.line('    ' + U.pad(x.stats.txBytes, 10) + U.pad(x.stats.txPackets, 9) +
            U.pad(x.stats.txErrors, 8) + '       0       0       0');
        }
      });
      return 0;
    }

    if (cmd === 'set') {
      if (needRoot(ctx)) return 2;
      var di = argv.indexOf('dev');
      var dev2 = di >= 0 ? argv[di + 1] : argv[0];
      var iface = net.getIface(dev2);
      if (!iface) { ctx.errLine('Cannot find device "' + dev2 + '"'); return 1; }
      var opts = {};
      for (var j = 0; j < argv.length; j++) {
        if (argv[j] === 'up') opts.up = true;
        else if (argv[j] === 'down') opts.up = false;
        else if (argv[j] === 'mtu') opts.mtu = argv[j + 1];
        else if (argv[j] === 'address') opts.mac = argv[j + 1];
        else if (argv[j] === 'master') opts.master = argv[j + 1];
        else if (argv[j] === 'nomaster') opts.master = null;
      }
      if (opts.mtu && (Number(opts.mtu) < 68 || Number(opts.mtu) > 65536)) {
        ctx.errLine('Error: mtu greater than device maximum.');
        return 2;
      }
      net.setLink(dev2, opts);
      if (opts.up === true && !iface.carrier) {
        ctx.machine.log('kernel', dev2 + ': NIC Link is Down');
      } else if (opts.up === true) {
        ctx.machine.log('kernel', dev2 + ': link becomes ready');
      } else if (opts.up === false) {
        ctx.machine.log('kernel', dev2 + ': link down');
      }
      return 0;
    }

    if (cmd === 'add') {
      if (needRoot(ctx)) return 2;
      var spec = {};
      for (var k = 0; k < argv.length; k++) {
        if (argv[k] === 'link') spec.link = argv[k + 1];
        else if (argv[k] === 'name') spec.name = argv[k + 1];
        else if (argv[k] === 'type') spec.type = argv[k + 1];
        else if (argv[k] === 'id') spec.vlanId = Number(argv[k + 1]);
        else if (argv[k] === 'mode') spec.bondMode = argv[k + 1];
      }
      if (!spec.name && argv[0] && argv[0] !== 'link') spec.name = argv[0];
      if (!spec.name || !spec.type) { ctx.errLine('Not enough information: "name"/"type" argument is required.'); return 1; }
      if (net.getIface(spec.name)) { ctx.errLine('RTNETLINK answers: File exists'); return 2; }
      if (spec.type === 'vlan') {
        if (!spec.link || !net.getIface(spec.link)) { ctx.errLine('Cannot find device "' + spec.link + '"'); return 1; }
        var parent = net.getIface(spec.link);
        net.addIface({ name: spec.name, type: 'vlan', link: spec.link, vlanId: spec.vlanId, mtu: parent.mtu, segment: parent.segment });
      } else if (spec.type === 'bridge' || spec.type === 'bond' || spec.type === 'dummy') {
        net.addIface({ name: spec.name, type: spec.type, bondMode: spec.bondMode });
      } else {
        ctx.errLine('Unknown device type ' + spec.type + '.');
        return 1;
      }
      return 0;
    }

    if (cmd === 'del' || cmd === 'delete') {
      if (needRoot(ctx)) return 2;
      var dn = argv.indexOf('dev') >= 0 ? argv[argv.indexOf('dev') + 1] : argv[0];
      if (!net.delIface(dn)) { ctx.errLine('Cannot find device "' + dn + '"'); return 1; }
      return 0;
    }
    ctx.errLine('Command "' + cmd + '" is unknown, try "ip link help".');
    return 1;
  }

  /* ---------- ip route ---------- */

  function parseRouteArgs(argv) {
    var spec = { dst: argv[0] };
    for (var i = 0; i < argv.length; i++) {
      if (argv[i] === 'via') spec.gw = argv[i + 1];
      else if (argv[i] === 'dev') spec.dev = argv[i + 1];
      else if (argv[i] === 'metric') spec.metric = Number(argv[i + 1]);
      else if (argv[i] === 'src') spec.src = argv[i + 1];
      else if (argv[i] === 'table') spec.table = argv[i + 1];
      else if (argv[i] === 'proto') spec.proto = argv[i + 1];
      else if (argv[i] === 'scope') spec.scope = argv[i + 1];
      else if (argv[i] === 'onlink') spec.onlink = true;
    }
    if (spec.dst && spec.dst !== 'default') {
      var c = U.parseCidr(spec.dst, 32);
      if (c) { spec.dst = c.ip; spec.prefix = c.prefix; }
      else if (spec.dst.indexOf(':') >= 0) {
        var p6 = spec.dst.split('/');
        spec.dst = p6[0]; spec.prefix = p6[1] ? Number(p6[1]) : 128; spec.family = 6;
      }
    }
    return spec;
  }

  function ipRoute(ctx, net, cmd, argv, family) {
    if (cmd === 'show' || cmd === 'list') {
      var table = 'main';
      var ti = argv.indexOf('table');
      if (ti >= 0) table = argv[ti + 1];
      var f = family || 4;
      var list = net.routes.filter(function (r) { return r.family === f && r.table === table; });
      list.sort(function (a, b) {
        if (a.prefix !== b.prefix) return b.prefix - a.prefix;
        return a.metric - b.metric;
      });
      /* ip route печатает default последним? нет — сначала default, как в Linux */
      var def = list.filter(function (r) { return r.prefix === 0; });
      var rest = list.filter(function (r) { return r.prefix !== 0; });
      def.concat(rest).forEach(function (r) { routeLine(ctx, r, net); });
      return 0;
    }

    if (cmd === 'get') {
      var dst = argv[0];
      if (!dst) { ctx.errLine('Command line is not complete. Try option "help"'); return 1; }
      var lr = net.lookupRoute(dst);
      if (!lr) {
        ctx.errLine('RTNETLINK answers: Network is unreachable');
        return 2;
      }
      var s = dst;
      if (lr.gw) s += ' via ' + lr.gw;
      s += ' dev ' + (lr.iface ? lr.iface.name : '?');
      if (lr.src) s += ' src ' + lr.src;
      s += ' uid ' + ctx.uid;
      ctx.line(s);
      ctx.line('    cache');
      return 0;
    }

    if (cmd === 'add' || cmd === 'del' || cmd === 'delete' || cmd === 'replace' || cmd === 'change') {
      if (needRoot(ctx)) return 2;
      var spec = parseRouteArgs(argv);
      if (!spec.dst) { ctx.errLine('Command line is not complete. Try option "help"'); return 1; }
      if (cmd === 'del' || cmd === 'delete') {
        var r = net.delRoute(spec);
        if (r.err) { ctx.errLine(r.err); return 2; }
        return 0;
      }
      if (cmd === 'replace' || cmd === 'change') net.delRoute(spec);
      if (spec.metric === undefined) spec.metric = 0;
      var res = net.addRoute(spec);
      if (res.err) { ctx.errLine(res.err); return 2; }
      ctx.machine.log('kernel', 'route added: ' + (spec.dst === 'default' ? 'default' : spec.dst + '/' + spec.prefix) +
        (spec.gw ? ' via ' + spec.gw : ''));
      return 0;
    }

    if (cmd === 'flush') {
      if (needRoot(ctx)) return 2;
      net.flushRoutes(family || 4);
      return 0;
    }
    ctx.errLine('Command "' + cmd + '" is unknown, try "ip route help".');
    return 1;
  }

  /* ---------- ip neigh ---------- */

  function ipNeigh(ctx, net, cmd, argv) {
    if (cmd === 'show' || cmd === 'list') {
      var dev = null;
      var di = argv.indexOf('dev');
      if (di >= 0) dev = argv[di + 1];
      net.neigh.filter(function (n) { return !dev || n.dev === dev; }).forEach(function (n) {
        ctx.line(n.ip + ' dev ' + n.dev + (n.lladdr ? ' lladdr ' + n.lladdr : '') + ' ' + n.state);
      });
      return 0;
    }
    if (cmd === 'flush') {
      if (needRoot(ctx)) return 2;
      var d = argv.indexOf('dev') >= 0 ? argv[argv.indexOf('dev') + 1] : null;
      net.flushNeigh(d);
      ctx.line('*** Round 1, deleting ' + (d ? '' : 'all ') + 'entries ***');
      return 0;
    }
    if (cmd === 'del' || cmd === 'delete') {
      if (needRoot(ctx)) return 2;
      net.delNeigh(argv[0], argv.indexOf('dev') >= 0 ? argv[argv.indexOf('dev') + 1] : null);
      return 0;
    }
    ctx.errLine('Command "' + cmd + '" is unknown, try "ip neigh help".');
    return 1;
  }

  function ipRule(ctx, net, cmd, argv) {
    net.rules.forEach(function (r) {
      ctx.line(r.prio + ':\t' + r.sel + '\t' + r.action);
    });
    return 0;
  }

  /* ---------- legacy ---------- */

  reg({
    name: 'ifconfig', category: 'net', summary: 'устаревший аналог ip addr',
    usage: 'ifconfig [IFACE] [up|down]',
    complete: function (ctx, word, argv, h) { return h.ifaces(ctx); },
    run: function (ctx) {
      var net = ctx.machine.net;
      var name = ctx.argv[0];
      if (name && (ctx.argv[1] === 'up' || ctx.argv[1] === 'down')) {
        if (needRoot(ctx)) return 1;
        net.setLink(name, { up: ctx.argv[1] === 'up' });
        return 0;
      }
      var list = net.ifaces.filter(function (i) {
        if (name) return i.name === name;
        return i.state === 'UP' || i.addrs.length;
      });
      if (name && !list.length) { ctx.errLine(name + ': error fetching interface information: Device not found'); return 1; }
      list.forEach(function (i) {
        var flags = [];
        if (i.type === 'loopback') flags.push('LOOPBACK'); else flags.push('BROADCAST');
        if (i.state === 'UP') flags.push('RUNNING');
        flags.push('MULTICAST');
        ctx.line(i.name + ': flags=' + (i.state === 'UP' ? 4163 : 4098) + '<' +
          (i.state === 'UP' ? 'UP,' : '') + flags.join(',') + '>  mtu ' + i.mtu);
        sortedAddrs(i).forEach(function (a) {
          if (a.family === 4) {
            ctx.line('        inet ' + a.ip + '  netmask ' + U.prefix2mask(a.prefix) +
              (a.prefix < 31 ? '  broadcast ' + U.broadcast(a.ip, a.prefix) : ''));
          } else {
            ctx.line('        inet6 ' + a.ip + '  prefixlen ' + a.prefix + '  scopeid 0x20<' + a.scope + '>');
          }
        });
        if (i.type !== 'loopback') ctx.line('        ether ' + i.mac + '  txqueuelen ' + i.txqueuelen + '  (Ethernet)');
        else ctx.line('        loop  txqueuelen 1000  (Local Loopback)');
        ctx.line('        RX packets ' + i.stats.rxPackets + '  bytes ' + i.stats.rxBytes);
        ctx.line('        TX packets ' + i.stats.txPackets + '  bytes ' + i.stats.txBytes);
        ctx.line('');
      });
      return 0;
    }
  });

  reg({
    name: 'route', category: 'net', summary: 'устаревший аналог ip route', usage: 'route [-n]',
    run: function (ctx) {
      var net = ctx.machine.net;
      var argv = ctx.argv;
      if (argv[0] === 'add' || argv[0] === 'del') {
        if (needRoot(ctx)) return 1;
        var spec = { dst: null };
        for (var i = 1; i < argv.length; i++) {
          if (argv[i] === '-net' || argv[i] === '-host') spec.dst = argv[i + 1];
          else if (argv[i] === 'default') { spec.dst = 'default'; }
          else if (argv[i] === 'gw') spec.gw = argv[i + 1];
          else if (argv[i] === 'netmask') spec.prefix = U.mask2prefix(argv[i + 1]);
          else if (argv[i] === 'dev') spec.dev = argv[i + 1];
        }
        if (!spec.dst) { ctx.errLine('route: netmask doesn\'t match route address'); return 1; }
        var r = argv[0] === 'add' ? net.addRoute(spec) : net.delRoute(spec);
        if (r.err) { ctx.errLine('SIOCADDRT: ' + r.err.replace('RTNETLINK answers: ', '')); return 1; }
        return 0;
      }
      ctx.line('Kernel IP routing table');
      ctx.line(U.padRight('Destination', 16) + U.padRight('Gateway', 16) + U.padRight('Genmask', 16) +
        'Flags Metric Ref    Use Iface');
      net.routes.filter(function (r) { return r.family === 4; }).forEach(function (r) {
        ctx.line(U.padRight(r.prefix === 0 ? 'default' : r.dst, 16) +
          U.padRight(r.gw || '0.0.0.0', 16) +
          U.padRight(U.prefix2mask(r.prefix), 16) +
          U.padRight(r.gw ? 'UG' : 'U', 6) + U.padRight(r.metric, 7) + '0        0 ' + (r.dev || ''));
      });
      return 0;
    }
  });

  reg({
    name: 'arp', category: 'net', summary: 'устаревший аналог ip neigh', usage: 'arp [-n] [-d IP]',
    run: function (ctx) {
      var net = ctx.machine.net;
      if (ctx.argv[0] === '-d') {
        if (needRoot(ctx)) return 1;
        net.delNeigh(ctx.argv[1]);
        return 0;
      }
      ctx.line(U.padRight('Address', 24) + U.padRight('HWtype', 8) + U.padRight('HWaddress', 20) +
        U.padRight('Flags Mask', 12) + 'Iface');
      net.neigh.forEach(function (n) {
        ctx.line(U.padRight(n.ip, 24) + U.padRight('ether', 8) +
          U.padRight(n.lladdr || '(incomplete)', 20) +
          U.padRight(n.lladdr ? 'C' : '', 12) + n.dev);
      });
      return 0;
    }
  });

  reg({
    name: 'ethtool', category: 'net', summary: 'состояние физического линка', usage: 'ethtool [-S] IFACE',
    complete: function (ctx, word, argv, h) { return h.ifaces(ctx); },
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['S', 'i', 'k'] });
      var name = p.rest[0];
      if (!name) return ctx.usageError('ethtool: bad command line argument(s)');
      var i = ctx.machine.net.getIface(name);
      if (!i) return ctx.fail('Cannot get device settings: No such device');
      if (p.flags.i) {
        ctx.line('driver: e1000');
        ctx.line('version: ' + ctx.machine.kernel);
        ctx.line('bus-info: 0000:02:01.0');
        return 0;
      }
      if (p.flags.S) {
        ctx.line('NIC statistics:');
        ctx.line('     rx_packets: ' + i.stats.rxPackets);
        ctx.line('     tx_packets: ' + i.stats.txPackets);
        ctx.line('     rx_errors: ' + i.stats.rxErrors);
        ctx.line('     tx_errors: ' + i.stats.txErrors);
        ctx.line('     rx_dropped: ' + i.stats.rxDropped);
        return 0;
      }
      ctx.line('Settings for ' + name + ':');
      ctx.line('\tSupported ports: [ TP ]');
      ctx.line('\tSupported link modes:   10baseT/Half 10baseT/Full');
      ctx.line('\t                        100baseT/Half 100baseT/Full');
      ctx.line('\t                        1000baseT/Full');
      ctx.line('\tSpeed: ' + (i.carrier ? '1000Mb/s' : 'Unknown!'));
      ctx.line('\tDuplex: ' + (i.carrier ? 'Full' : 'Unknown! (255)'));
      ctx.line('\tPort: Twisted Pair');
      ctx.line('\tAuto-negotiation: on');
      ctx.line('\tMDI-X: off (auto)');
      ctx.line('\tLink detected: ' + (i.carrier ? 'yes' : 'no'));
      return 0;
    }
  });

  reg({
    name: 'bridge', category: 'net', summary: 'мосты и порты', usage: 'bridge link show',
    run: function (ctx) {
      var net = ctx.machine.net;
      net.ifaces.forEach(function (i) {
        if (!i.master) return;
        ctx.line(i.index + ': ' + i.name + ': <BROADCAST,MULTICAST,UP,LOWER_UP> mtu ' + i.mtu +
          ' master ' + i.master + ' state forwarding priority 32 cost 4');
      });
      return 0;
    }
  });

  /* ipcalc — границы подсети. Формат как у ipcalc 0.51 из Ubuntu (-b — без двоичного вида). */
  function bits(ip, prefix) {
    var b = ('00000000000000000000000000000000' + (U.ip2int(ip) >>> 0).toString(2)).slice(-32);
    var dotted = b.slice(0, 8) + '.' + b.slice(8, 16) + '.' + b.slice(16, 24) + '.' + b.slice(24);
    var cut = prefix + Math.floor(prefix / 8) - (prefix % 8 === 0 && prefix > 0 ? 1 : 0);
    if (prefix % 8 === 0) return dotted;
    return dotted.slice(0, cut) + ' ' + dotted.slice(cut);
  }

  reg({
    name: 'ipcalc', category: 'net', summary: 'калькулятор подсетей IPv4',
    usage: 'ipcalc [-b] ADDRESS[/PREFIX] [NETMASK]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['b', 'n', 'nobinary'] });
      if (!p.rest.length) return ctx.fail('Usage: ipcalc [options] <ADDRESS>[[/]<NETMASK>] [NETMASK]', 1);
      var parts = String(p.rest[0]).split('/');
      var ip = parts[0], prefix = 24;
      if (parts.length > 1) prefix = U.isIPv4(parts[1]) ? U.mask2prefix(parts[1]) : Number(parts[1]);
      else if (p.rest[1]) prefix = U.isIPv4(p.rest[1]) ? U.mask2prefix(p.rest[1]) : Number(p.rest[1]);
      if (!U.isIPv4(ip)) return ctx.fail('INVALID ADDRESS: ' + ip, 1);
      if (!/^\d+$/.test(String(prefix)) || prefix < 0 || prefix > 32) {
        return ctx.fail('INVALID MASK1:  ' + (parts[1] || p.rest[1]), 1);
      }
      var bin = !(p.flags.b || p.flags.n || p.flags.nobinary);
      var mask = U.prefix2mask(prefix);
      var wild = U.int2ip((~U.ip2int(mask)) >>> 0);
      var net = U.network(ip, prefix), bc = U.broadcast(ip, prefix);
      function row(label, value, b) {
        ctx.line((U.padRight(label, 11) + U.padRight(value, 21) + (bin && b ? b : '')).replace(/\s+$/, ''));
      }
      row('Address:', ip, bits(ip, prefix));
      row('Netmask:', mask + ' = ' + prefix, bits(mask, prefix));
      row('Wildcard:', wild, bits(wild, prefix));
      ctx.line('=>');
      row('Network:', net + '/' + prefix, bits(net, prefix));
      if (prefix <= 30) {
        var hmin = U.int2ip(U.ip2int(net) + 1), hmax = U.int2ip(U.ip2int(bc) - 1);
        row('HostMin:', hmin, bits(hmin, prefix));
        row('HostMax:', hmax, bits(hmax, prefix));
        row('Broadcast:', bc, bits(bc, prefix));
        ctx.line(U.padRight('Hosts/Net:', 11) + U.padRight(String(Math.pow(2, 32 - prefix) - 2), 21) + privClass(ip));
      } else {
        row('Hostroute:', ip, bits(ip, prefix));
        ctx.line(U.padRight('Hosts/Net:', 11) + U.padRight(String(prefix === 32 ? 1 : 2), 21) + privClass(ip));
      }
      return 0;
    }
  });

  function privClass(ip) {
    var o = ip.split('.').map(Number);
    var cls = o[0] < 128 ? 'A' : (o[0] < 192 ? 'B' : (o[0] < 224 ? 'C' : 'D'));
    var priv = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
    return 'Class ' + cls + (priv ? ', Private Internet' : '');
  }
})(window.NET);
