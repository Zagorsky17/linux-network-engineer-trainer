/*
 * packet.js — движок прохождения пакета по топологии. Ядро всего тренажёра.
 *
 * Один и тот же код обслуживает ping, traceroute, tcp-подключения, DNS, DHCP,
 * curl и tcpdump. Поэтому любая поломка в модели (down-интерфейс, неверная
 * маска, отсутствующий default route, DROP в firewall, MTU-blackhole) даёт
 * согласованную картину во всех командах — как на настоящем сервере.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var MAX_HOPS = 30;

  var E = {
    NETUNREACH: 'ENETUNREACH',      // нет маршрута локально
    NETDOWN: 'ENETDOWN',            // интерфейс down / нет линка
    HOSTUNREACH: 'EHOSTUNREACH',    // ARP не разрешился (шлюз вне подсети, нет хоста)
    MSGSIZE: 'EMSGSIZE',            // локальный MTU меньше пакета, DF
    FRAGNEEDED: 'EFRAGNEEDED',      // ICMP frag needed от роутера
    BLACKHOLE: 'EBLACKHOLE',        // frag needed заглушен => таймаут
    TIMEOUT: 'ETIMEDOUT',           // пакет пропал (DROP/нет ответа)
    REFUSED: 'ECONNREFUSED',        // RST / порт закрыт
    PORTUNREACH: 'EPORTUNREACH',    // ICMP port unreachable (udp)
    TTL: 'ETTLEXPIRED',
    PERM: 'EPERM',                  // заблокировано локальным OUTPUT
    UNREACH_ADMIN: 'EADMINPROHIB'   // REJECT с icmp-admin-prohibited
  };

  /* ---------- L2: сегменты ---------- */

  /*
   * Эффективный L2-домен интерфейса.
   * VLAN-интерфейс живёт в поддомене родителя, bridge/bond — в домене
   * первого работающего slave. Именно это делает лабораторию с VLAN честной:
   * access-порт в чужом VLAN физически не увидит шлюз.
   */
  function effSegment(machine, iface, depth) {
    if (!iface || (depth || 0) > 5) return null;
    if (iface.type === 'vlan' && iface.link) {
      var parent = machine.net.getIface(iface.link);
      var base = effSegment(machine, parent, (depth || 0) + 1);
      return base ? base + '#' + iface.vlanId : null;
    }
    if ((iface.type === 'bridge' || iface.type === 'bond') && iface.slaves.length) {
      for (var i = 0; i < iface.slaves.length; i++) {
        var sl = machine.net.getIface(iface.slaves[i]);
        if (sl && sl.carrier && sl.state === 'UP') return effSegment(machine, sl, (depth || 0) + 1);
      }
      return null;
    }
    return iface.segment;
  }

  /* Кто в этом L2-домене владеет адресом ip. Несколько владельцев = конфликт IP. */
  function ownersOnSegment(world, segment, ip, exclude) {
    var out = [];
    if (!segment) return out;
    world.each(function (m) {
      if (m === exclude) return;
      m.net.ifaces.forEach(function (i) {
        if (i.type === 'loopback') return;
        if (effSegment(m, i) !== segment) return;
        if (!m.net.operational(i)) return;
        var has = i.addrs.some(function (a) { return a.ip === ip; });
        if (has) out.push({ machine: m, iface: i });
      });
    });
    return out;
  }

  /* ---------- capture ---------- */

  function rec(world, node, iface, p) {
    if (!world.capture || !world.capture.enabled) return;
    world.capture.record({
      node: node.name, iface: iface ? iface.name : 'lo',
      src: p.src, dst: p.dst, proto: p.proto,
      sport: p.sport, dport: p.dport, flags: p.flags || null,
      len: p.len || 64, info: p.info || null,
      srcMac: p.srcMac || (iface ? iface.mac : '00:00:00:00:00:00'),
      dstMac: p.dstMac || null,
      icmpType: p.icmpType || null, ttl: p.ttl
    });
  }

  /* ---------- локальная доставка ---------- */

  function localDeliver(world, node, inIface, pkt) {
    var fwPkt = {
      proto: pkt.proto, src: pkt.src, dst: pkt.dst, sport: pkt.sport, dport: pkt.dport,
      inIface: inIface ? inIface.name : 'lo', ct: pkt.ct || 'NEW', icmpType: pkt.icmpType
    };
    var verdict = node.fw.evaluate('INPUT', fwPkt);
    if (verdict === 'DROP') return { ok: false, error: E.TIMEOUT, filtered: true, at: node };
    if (verdict === 'REJECT') {
      return {
        ok: false, at: node,
        error: pkt.proto === 'tcp' ? E.REFUSED : E.UNREACH_ADMIN,
        rejected: true
      };
    }

    if (pkt.proto === 'icmp') {
      if (node.net.sysctl['net.ipv4.icmp_echo_ignore_all'] === '1' || (node.quirks && node.quirks.dropIcmp)) {
        return { ok: false, error: E.TIMEOUT, at: node };
      }
      return { ok: true, at: node, kind: 'echo-reply' };
    }

    var sock = node.net.listening(pkt.dport, pkt.proto, pkt.dst);
    if (!sock) {
      if (pkt.proto === 'tcp') return { ok: false, error: E.REFUSED, at: node, rst: true };
      return { ok: false, error: E.PORTUNREACH, at: node };
    }
    return { ok: true, at: node, socket: sock, unit: sock.unit };
  }

  /* ---------- основной проход ---------- */

  /*
   * send(world, src, dstIP, opts) — отправляет один пакет и возвращает исход.
   * opts: {proto, sport, dport, size, df, ttl, srcIP, dev, ct, icmpType, quiet}
   */
  function send(world, src, dstIP, opts) {
    opts = opts || {};
    var proto = opts.proto || 'icmp';
    var size = opts.size === undefined ? 84 : opts.size;
    var ttl = opts.ttl === undefined ? 64 : opts.ttl;
    var hops = [];
    var result = { ok: false, error: null, hops: hops, rtt: 0, dst: null, ttl: ttl };

    /* loopback и собственные адреса */
    var own = src.net.ownsIP(dstIP);
    var isLoop = dstIP === '127.0.0.1' || dstIP === 'localhost' || dstIP === '::1' ||
      (own && own.iface.type === 'loopback');
    if (isLoop || own) {
      var lif = own ? own.iface : src.net.getIface('lo');
      if (own && !isLoop && !src.net.operational(lif)) {
        result.error = E.NETDOWN; return result;
      }
      var lsrc = isLoop ? (dstIP === '::1' ? '::1' : '127.0.0.1') : dstIP;
      var pk = {
        src: lsrc, dst: dstIP, proto: proto, sport: opts.sport, dport: opts.dport,
        len: size, flags: proto === 'tcp' ? 'S' : null, info: null, ttl: ttl
      };
      rec(world, src, isLoop ? src.net.getIface('lo') : lif, pk);
      var lr = localDeliver(world, src, isLoop ? src.net.getIface('lo') : lif, {
        proto: proto, src: lsrc, dst: dstIP, sport: opts.sport, dport: opts.dport, ct: opts.ct
      });
      hops.push({ ip: dstIP, node: src.name, iface: lif ? lif.name : 'lo' });
      result.ok = lr.ok; result.error = lr.error || null;
      result.dst = { machine: src, iface: lif }; result.socket = lr.socket;
      result.rtt = 0.04 + Math.random() * 0.03;
      result.filtered = lr.filtered; result.rejected = lr.rejected;
      return result;
    }

    /* 1. маршрут */
    var lr2 = src.net.lookupRoute(dstIP);
    if (!lr2 || !lr2.iface) { result.error = E.NETUNREACH; return result; }
    if (!src.net.operational(lr2.iface)) { result.error = E.NETDOWN; result.iface = lr2.iface.name; return result; }
    var srcIP = opts.srcIP || lr2.src;
    if (!srcIP) { result.error = E.NETUNREACH; result.noSource = true; return result; }

    /* 2. OUTPUT firewall */
    var outVerdict = src.fw.evaluate('OUTPUT', {
      proto: proto, src: srcIP, dst: dstIP, sport: opts.sport, dport: opts.dport,
      outIface: lr2.iface.name, ct: opts.ct || 'NEW', icmpType: opts.icmpType
    });
    if (outVerdict === 'DROP') { result.error = E.TIMEOUT; result.filtered = true; return result; }
    if (outVerdict === 'REJECT') { result.error = E.PERM; return result; }

    /* 3. локальный MTU */
    if (size > lr2.iface.mtu) {
      if (opts.df) { result.error = E.MSGSIZE; result.mtu = lr2.iface.mtu; return result; }
      size = lr2.iface.mtu;   // фрагментация: дальше едет по частям
    }

    var pkt = {
      src: srcIP, dst: dstIP, proto: proto, sport: opts.sport, dport: opts.dport,
      len: size, df: !!opts.df, ct: opts.ct || 'NEW', icmpType: opts.icmpType,
      flags: proto === 'tcp' ? 'S' : null, ttl: ttl
    };

    var node = src, iface = lr2.iface, nextHop = lr2.nextHop, route = lr2.route;
    var latency = 0;

    for (var hop = 0; hop < MAX_HOPS; hop++) {
      /* 4. next-hop должен быть в подсети интерфейса (иначе ARP невозможен) */
      var reachable = route.onlink || sameLink(node, iface, nextHop);
      if (!reachable) {
        node.net.setNeigh(nextHop, iface.name, null, 'FAILED');
        result.error = E.HOSTUNREACH; result.arpFail = nextHop; return result;
      }

      var seg = effSegment(node, iface);
      var owners = ownersOnSegment(world, seg, nextHop, null);
      var peer = owners.filter(function (o) { return o.machine !== node; })[0];

      rec(world, node, iface, {
        src: pkt.src, dst: pkt.dst, proto: pkt.proto, sport: pkt.sport, dport: pkt.dport,
        len: pkt.len, flags: pkt.flags, ttl: pkt.ttl,
        dstMac: peer ? peer.iface.mac : 'ff:ff:ff:ff:ff:ff'
      });

      if (!peer) {
        node.net.setNeigh(nextHop, iface.name, null, 'INCOMPLETE');
        rec(world, node, iface, {
          src: pkt.src, dst: nextHop, proto: 'arp', len: 42,
          info: 'who-has ' + nextHop + ' tell ' + pkt.src, dstMac: 'ff:ff:ff:ff:ff:ff'
        });
        result.error = E.HOSTUNREACH; result.arpFail = nextHop; return result;
      }

      if (owners.length > 1) result.ipConflict = nextHop;
      node.net.setNeigh(nextHop, iface.name, peer.iface.mac, 'REACHABLE');

      var next = peer.machine, inIface = peer.iface;
      latency += (next.latency === undefined ? 0.4 : next.latency);
      hops.push({ ip: firstAddrOf(inIface) || nextHop, node: next.name, iface: inIface.name });

      /* потери пакетов на узле (лаборатория packet loss) */
      if (next.quirks && next.quirks.loss && Math.random() < next.quirks.loss) {
        result.error = E.TIMEOUT; result.lost = true; result.rtt = latency * 2; return result;
      }

      /*
       * Приём на входном интерфейсе. tcpdump видит пакет раньше netfilter,
       * поэтому запись делается до проверки INPUT/FORWARD: SYN, отброшенный
       * правилом DROP, всё равно виден в дампе на сервере — это и есть
       * главный признак фильтрации на самом хосте.
       */
      rec(world, next, inIface, {
        src: pkt.src, dst: pkt.dst, proto: pkt.proto, sport: pkt.sport, dport: pkt.dport,
        len: pkt.len, flags: pkt.flags, ttl: pkt.ttl,
        srcMac: iface.mac, dstMac: inIface.mac
      });

      /* 5. пакет пришёл адресату? */
      if (next.net.ownsIP(pkt.dst)) {
        var dr = localDeliver(world, next, inIface, pkt);
        result.ok = dr.ok;
        result.error = dr.error || null;
        result.dst = { machine: next, iface: inIface };
        result.socket = dr.socket;
        result.filtered = dr.filtered; result.rejected = dr.rejected;
        result.rtt = latency * 2 + Math.random() * 0.4;
        if (dr.ok) {
          rec(world, next, inIface, {
            src: pkt.dst, dst: pkt.src, proto: pkt.proto,
            sport: pkt.dport, dport: pkt.sport, len: pkt.len,
            flags: pkt.proto === 'tcp' ? 'S.' : null,
            icmpType: pkt.proto === 'icmp' ? 'echo reply' : null, ttl: 64
          });
        } else if (dr.rst) {
          rec(world, next, inIface, {
            src: pkt.dst, dst: pkt.src, proto: 'tcp', sport: pkt.dport, dport: pkt.sport,
            len: 54, flags: 'R.', ttl: 64
          });
        }
        return result;
      }

      /* 6. транзитный узел: маршрутизация */
      if (!isForwarding(next)) {
        result.error = E.TIMEOUT; result.blackholeAt = next.name; result.rtt = latency * 2; return result;
      }

      pkt.ttl--;
      if (pkt.ttl <= 0) {
        result.error = E.TTL;
        result.errorFrom = firstAddrOf(inIface);
        result.rtt = latency * 2 + Math.random() * 0.5;
        return result;
      }

      var nlr = next.net.lookupRoute(pkt.dst);
      if (!nlr || !nlr.iface) {
        result.error = E.NETUNREACH;
        result.errorFrom = firstAddrOf(inIface);
        result.unreachFromRouter = true;
        result.rtt = latency * 2;
        return result;
      }
      if (!next.net.operational(nlr.iface)) {
        result.error = E.NETDOWN; result.errorFrom = firstAddrOf(inIface); return result;
      }

      var fv = next.fw.evaluate('FORWARD', {
        proto: pkt.proto, src: pkt.src, dst: pkt.dst, sport: pkt.sport, dport: pkt.dport,
        inIface: inIface.name, outIface: nlr.iface.name, ct: pkt.ct, icmpType: pkt.icmpType
      });
      if (fv === 'DROP') { result.error = E.TIMEOUT; result.filtered = true; result.filteredAt = next.name; return result; }
      if (fv === 'REJECT') {
        result.error = E.UNREACH_ADMIN; result.errorFrom = firstAddrOf(inIface); return result;
      }

      /* 7. MTU по пути: классический blackhole, если ICMP frag needed заглушен */
      if (pkt.len > nlr.iface.mtu) {
        if (pkt.df) {
          if (next.quirks && next.quirks.dropIcmpFragNeeded) {
            result.error = E.BLACKHOLE; result.mtu = nlr.iface.mtu; result.mtuAt = next.name;
            return result;
          }
          result.error = E.FRAGNEEDED; result.mtu = nlr.iface.mtu;
          result.errorFrom = firstAddrOf(inIface); result.mtuAt = next.name;
          return result;
        }
        pkt.len = nlr.iface.mtu;
      }

      node = next; iface = nlr.iface; route = nlr.route; nextHop = nlr.nextHop;
      if (!pkt.srcRewritten && nlr.route.proto === 'nat') pkt.src = nlr.src;
    }

    result.error = E.TTL;
    return result;
  }

  function firstAddrOf(iface) {
    for (var i = 0; i < iface.addrs.length; i++) {
      if (iface.addrs[i].family === 4) return iface.addrs[i].ip;
    }
    return iface.addrs.length ? iface.addrs[0].ip : null;
  }

  function sameLink(machine, iface, ip) {
    var v6 = ip.indexOf(':') >= 0;
    for (var i = 0; i < iface.addrs.length; i++) {
      var a = iface.addrs[i];
      if (v6 && a.family === 6 && U.v6SameNet(a.ip, ip, a.prefix)) return true;
      if (!v6 && a.family === 4 && U.sameSubnet(a.ip, ip, a.prefix)) return true;
    }
    return false;
  }

  function isForwarding(m) {
    if (m.router) return true;
    return m.net.sysctl['net.ipv4.ip_forward'] === '1';
  }

  /* ---------- высокоуровневые операции ---------- */

  /* TCP-рукопожатие. Возвращает {ok, error, hops, rtt, socket, service} */
  function tcpConnect(world, src, dstIP, port, opts) {
    opts = opts || {};
    var sport = opts.sport || U.randInt(32768, 60999);
    var r = send(world, src, dstIP, {
      proto: 'tcp', dport: port, sport: sport, size: 74, ttl: opts.ttl || 64, df: true,
      srcIP: opts.srcIP
    });
    if (r.ok) {
      // ACK третьим пакетом — виден в tcpdump, это учебный момент
      if (world.capture && world.capture.enabled && r.hops.length) {
        var lr = src.net.lookupRoute(dstIP);
        if (lr && lr.iface) {
          rec(world, src, lr.iface, {
            src: lr.src, dst: dstIP, proto: 'tcp', sport: sport, dport: port,
            len: 66, flags: '.', ttl: 64
          });
        }
      }
      var est = src.net.establish({
        addr: r.hops.length ? (src.net.lookupRoute(dstIP) || {}).src : null,
        port: sport, peerAddr: dstIP, peerPort: port, process: opts.process || 'client'
      });
      r.localSocket = est;
      r.service = r.dst && r.dst.machine.services
        ? r.dst.machine.services.byPort(port, 'tcp') : null;
    }
    r.sport = sport;
    return r;
  }

  function udpSend(world, src, dstIP, port, opts) {
    opts = opts || {};
    return send(world, src, dstIP, {
      proto: 'udp', dport: port, sport: opts.sport || U.randInt(32768, 60999),
      size: opts.size || 76, ttl: opts.ttl || 64, srcIP: opts.srcIP
    });
  }

  function icmpEcho(world, src, dstIP, opts) {
    opts = opts || {};
    return send(world, src, dstIP, {
      proto: 'icmp', size: (opts.size === undefined ? 56 : opts.size) + 28,
      df: opts.df, ttl: opts.ttl || 64, icmpType: 'echo-request', srcIP: opts.srcIP
    });
  }

  /* traceroute: по 3 пробы на каждый TTL, пока не дойдём до цели */
  function traceroute(world, src, dstIP, opts) {
    opts = opts || {};
    var maxTtl = opts.maxTtl || 30;
    var out = [];
    for (var ttl = 1; ttl <= maxTtl; ttl++) {
      var probes = [];
      var reached = false, fatal = null;
      for (var p = 0; p < (opts.probes || 3); p++) {
        var r = opts.icmp
          ? icmpEcho(world, src, dstIP, { ttl: ttl, size: 56 })
          : udpSend(world, src, dstIP, 33434 + ttl, { ttl: ttl });
        if (r.error === E.TTL && r.errorFrom) probes.push({ ip: r.errorFrom, rtt: r.rtt });
        else if (r.ok) { probes.push({ ip: dstIP, rtt: r.rtt }); reached = true; }
        else if (r.error === E.PORTUNREACH) { probes.push({ ip: dstIP, rtt: r.rtt }); reached = true; }
        else if (r.error === E.UNREACH_ADMIN) probes.push({ ip: r.errorFrom, rtt: r.rtt, note: '!X' });
        else if (r.error === E.NETUNREACH && r.errorFrom) probes.push({ ip: r.errorFrom, rtt: r.rtt, note: '!N' });
        else if (r.error === E.NETUNREACH || r.error === E.NETDOWN || r.error === E.HOSTUNREACH) {
          fatal = r.error; break;
        } else probes.push(null);
      }
      if (fatal) return { hops: out, fatal: fatal };
      out.push({ ttl: ttl, probes: probes });
      if (reached) return { hops: out, reached: true };
    }
    return { hops: out, reached: false };
  }

  NET.packet = {
    E: E,
    send: send,
    tcpConnect: tcpConnect,
    udpSend: udpSend,
    icmpEcho: icmpEcho,
    traceroute: traceroute,
    effSegment: effSegment,
    ownersOnSegment: ownersOnSegment,
    firstAddrOf: firstAddrOf,
    isForwarding: isForwarding,
    record: rec
  };
})(window.NET);
