/*
 * dns.js — резолвер и авторитетные зоны.
 *
 * Запрос идёт настоящим UDP-пакетом через packet.js, поэтому «DNS не работает»
 * может иметь разные причины: нет маршрута до сервера, сервер выключен,
 * порт 53 закрыт firewall'ом, зона пустая, systemd-resolved неактивен.
 * Пользователь обязан различить их по симптомам — это и есть навык.
 */
(function (NET) {
  'use strict';

  var P = NET.packet;

  function zoneOf(node, qname) {
    if (!node.dns || !node.dns.zones) return null;
    var best = null;
    Object.keys(node.dns.zones).forEach(function (z) {
      if (qname === z || qname.slice(-(z.length + 1)) === '.' + z) {
        if (!best || z.length > best.length) best = z;
      }
    });
    return best;
  }

  function relName(qname, zone) {
    if (qname === zone) return '@';
    return qname.slice(0, qname.length - zone.length - 1);
  }

  /* Поиск в авторитетной зоне; возвращает массив записей (с разворотом CNAME). */
  function lookupZone(node, qname, type, depth) {
    var zone = zoneOf(node, qname);
    if (!zone) return null;
    var records = node.dns.zones[zone].records || [];
    var rel = relName(qname, zone);
    var answers = [];
    records.forEach(function (r) {
      if (r.name !== rel) return;
      if (r.type === type) answers.push({ name: qname, ttl: r.ttl || 300, type: r.type, value: r.value });
    });
    if (!answers.length) {
      var cname = null;
      records.forEach(function (r) { if (r.name === rel && r.type === 'CNAME') cname = r; });
      if (cname && (depth || 0) < 5) {
        var target = cname.value;
        answers.push({ name: qname, ttl: cname.ttl || 300, type: 'CNAME', value: target });
        var more = lookupZone(node, target.replace(/\.$/, ''), type, (depth || 0) + 1);
        if (more && more.answers) answers = answers.concat(more.answers);
      }
    }
    var exists = records.some(function (r) { return r.name === rel; });
    return {
      zone: zone, answers: answers, nxdomain: !exists && !answers.length,
      soa: (node.dns.zones[zone].soa || (zone + '. hostmaster.' + zone + '. 1 7200 900 1209600 86400'))
    };
  }

  /* Прямой запрос к конкретному серверу. */
  function queryServer(world, src, serverIP, qname, type, depth) {
    /* форвардеры могут зациклиться при неудачной настройке зон — ограничиваем */
    depth = depth || 0;
    if (depth > 4) {
      return { status: 'SERVFAIL', server: serverIP, answers: [], loop: true };
    }
    var net = P.udpSend(world, src, serverIP, 53, { size: 73 + qname.length });
    if (!net.ok) {
      var status = 'TIMEOUT';
      if (net.error === NET.packet.E.REFUSED || net.error === NET.packet.E.PORTUNREACH) status = 'REFUSED';
      if (net.error === NET.packet.E.NETUNREACH) status = 'UNREACH';
      if (net.error === NET.packet.E.HOSTUNREACH) status = 'UNREACH';
      return { status: status, net: net, server: serverIP, answers: [] };
    }
    var node = net.dst.machine;
    var sock = node.net.listening(53, 'udp', serverIP);
    var unit = sock && sock.unit;
    if (unit && node.services && !node.services.isActive(unit)) {
      return { status: 'TIMEOUT', server: serverIP, answers: [], net: net };
    }
    var res = lookupZone(node, qname, type, 0);
    if (!res) {
      if (node.dns && node.dns.recursive && node.dns.forwarders && node.dns.forwarders.length) {
        var up = queryServer(world, node, node.dns.forwarders[0], qname, type, depth + 1);
        up.server = serverIP; up.rtt = (net.rtt || 1) + (up.rtt || 1);
        return up;
      }
      if (node.dns && node.dns.recursive) {
        return { status: 'NXDOMAIN', server: serverIP, answers: [], rtt: net.rtt, authority: '. 1800 IN SOA a.root-servers.net.' };
      }
      return { status: 'REFUSED', server: serverIP, answers: [], rtt: net.rtt };
    }
    if (node.dns.broken) return { status: 'SERVFAIL', server: serverIP, answers: [], rtt: net.rtt };
    return {
      status: res.nxdomain ? 'NXDOMAIN' : 'NOERROR',
      server: serverIP, answers: res.answers, rtt: net.rtt,
      authority: res.nxdomain ? (res.zone + '. 900 IN SOA ' + res.soa) : null,
      aa: true
    };
  }

  /* Резолверы машины: /etc/resolv.conf + учёт systemd-resolved stub. */
  function resolvers(machine) {
    var out = [];
    try {
      var conf = machine.vfs.read('/etc/resolv.conf', { uid: 0, gid: 0 });
      conf.split('\n').forEach(function (l) {
        var m = l.match(/^\s*nameserver\s+(\S+)/);
        if (m) out.push(m[1]);
      });
    } catch (e) { /* файла нет — резолверов нет */ }
    return out;
  }

  function searchDomains(machine) {
    var out = [];
    try {
      var conf = machine.vfs.read('/etc/resolv.conf', { uid: 0, gid: 0 });
      conf.split('\n').forEach(function (l) {
        var m = l.match(/^\s*(?:search|domain)\s+(.+)$/);
        if (m) out = out.concat(m[1].trim().split(/\s+/));
      });
    } catch (e) {}
    return out;
  }

  function hostsLookup(machine, name, type) {
    var want = type === 'AAAA' ? 6 : 4;
    try {
      var hosts = machine.vfs.read('/etc/hosts', { uid: 0, gid: 0 });
      var found = null;
      hosts.split('\n').forEach(function (line) {
        var l = line.replace(/#.*$/, '').trim();
        if (!l) return;
        var parts = l.split(/\s+/);
        var ip = parts[0];
        var isV6 = ip.indexOf(':') >= 0;
        if ((want === 6) !== isV6) return;
        for (var i = 1; i < parts.length; i++) {
          if (parts[i] === name && !found) found = ip;
        }
      });
      return found;
    } catch (e) { return null; }
  }

  /*
   * Полный резолв как в getaddrinfo: /etc/hosts -> nameserver'ы по порядку.
   * Возвращает {ip, status, server, answers, rtt, viaHosts, tried:[]}
   */
  function resolve(world, machine, name, opts) {
    opts = opts || {};
    var type = opts.type || 'A';
    var tried = [];

    if (NET.util.isIPv4(name) || (NET.util.isIPv6(name) && name.indexOf(':') >= 0)) {
      return { ip: name, status: 'NOERROR', literal: true, answers: [], tried: tried };
    }

    if (!opts.noHosts) {
      var h = hostsLookup(machine, name, type);
      if (h) return { ip: h, status: 'NOERROR', viaHosts: true, answers: [{ name: name, type: type, value: h, ttl: 0 }], tried: tried };
    }

    var servers = opts.server ? [opts.server] : resolvers(machine);
    if (!servers.length) {
      return { status: 'NORESOLVER', answers: [], tried: tried };
    }

    var candidates = [name];
    if (name.indexOf('.') < 0) {
      searchDomains(machine).forEach(function (d) { candidates.push(name + '.' + d); });
    }

    var last = null;
    for (var s = 0; s < servers.length; s++) {
      var server = servers[s];
      /* systemd-resolved: 127.0.0.53 — заглушка, которая сама спрашивает upstream */
      if (server === '127.0.0.53') {
        if (!machine.services || !machine.services.isActive('systemd-resolved')) {
          tried.push({ server: server, status: 'TIMEOUT' });
          last = { status: 'TIMEOUT', server: server, answers: [], stubDown: true };
          continue;
        }
        var upstream = (machine.resolved && machine.resolved.upstream) || [];
        if (!upstream.length) {
          tried.push({ server: server, status: 'SERVFAIL' });
          last = { status: 'SERVFAIL', server: server, answers: [] };
          continue;
        }
        for (var u = 0; u < upstream.length; u++) {
          for (var ci = 0; ci < candidates.length; ci++) {
            var ru = queryServer(world, machine, upstream[u], candidates[ci], type);
            tried.push({ server: upstream[u], status: ru.status, via: '127.0.0.53' });
            if (ru.status === 'NOERROR' && ru.answers.length) {
              return finish(ru, candidates[ci], type, server, tried);
            }
            last = ru;
          }
        }
        continue;
      }

      for (var c = 0; c < candidates.length; c++) {
        var r = queryServer(world, machine, server, candidates[c], type);
        tried.push({ server: server, status: r.status });
        if (r.status === 'NOERROR' && r.answers.length) {
          return finish(r, candidates[c], type, server, tried);
        }
        last = r;
        if (r.status === 'NXDOMAIN') break;
      }
    }
    var out = last || { status: 'TIMEOUT', answers: [] };
    out.tried = tried;
    out.ip = null;
    return out;
  }

  function finish(r, qname, type, server, tried) {
    var ip = null;
    r.answers.forEach(function (a) { if (a.type === type && !ip) ip = a.value; });
    return {
      ip: ip, status: r.status, server: server, answers: r.answers,
      rtt: r.rtt, qname: qname, tried: tried, aa: r.aa
    };
  }

  /* Обратный резолв: ищем PTR во всех зонах доступного сервера. */
  function reverse(world, machine, ip) {
    var parts = ip.split('.').reverse().join('.') + '.in-addr.arpa';
    return resolve(world, machine, parts, { type: 'PTR', noHosts: true });
  }

  NET.dns = {
    resolve: resolve,
    reverse: reverse,
    queryServer: queryServer,
    resolvers: resolvers,
    searchDomains: searchDomains,
    hostsLookup: hostsLookup,
    lookupZone: lookupZone
  };
})(window.NET);
