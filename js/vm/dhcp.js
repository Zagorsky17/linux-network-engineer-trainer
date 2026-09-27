/*
 * dhcp.js — DHCP-сервер и клиент.
 * Клиент реально «шлёт» DISCOVER в L2-сегмент: если интерфейс down, сервер
 * выключен, пул исчерпан или порт в чужом VLAN — адреса не будет, и причина
 * различима командами (ip link, journalctl, tcpdump, ss на сервере).
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var P = NET.packet;

  /* Ищем DHCP-серверы в том же L2-домене. */
  function serversOnSegment(world, client, iface) {
    var seg = P.effSegment(client, iface);
    var out = [];
    if (!seg) return out;
    world.each(function (m) {
      if (m === client || !m.dhcp || !m.dhcp.enabled) return;
      /* сервер живёт только пока запущен его юнит — это диагностируется ss/systemctl */
      if (m.services && m.services.get('isc-dhcp-server') && !m.services.isActive('isc-dhcp-server')) return;
      m.net.ifaces.forEach(function (i) {
        if (P.effSegment(m, i) !== seg || !m.net.operational(i)) return;
        out.push({ machine: m, iface: i });
      });
    });
    return out;
  }

  function freeAddress(server, clientMac) {
    var d = server.dhcp;
    d.leases = d.leases || {};
    var existing = Object.keys(d.leases).filter(function (ip) {
      return d.leases[ip].mac === clientMac;
    })[0];
    if (existing) return existing;
    var pool = U.hostsInRange(d.pool.start, d.pool.end);
    for (var i = 0; i < pool.length; i++) {
      if (!d.leases[pool[i]]) return pool[i];
    }
    return null;
  }

  /*
   * request(world, client, ifname) -> {ok, lease:{ip,prefix,router,dns,domain,lease,server}}
   *                                  | {err, reason}
   */
  function request(world, client, ifname) {
    var iface = client.net.getIface(ifname);
    if (!iface) return { err: 'no device', reason: 'nodev' };
    client.log('dhclient', 'DHCPDISCOVER on ' + ifname + ' to 255.255.255.255 port 67 interval 3');
    if (!client.net.operational(iface)) {
      client.log('dhclient', 'receive_packet failed on ' + ifname + ': Network is down', 'err');
      return { err: 'link down', reason: 'linkdown' };
    }

    if (world.capture) {
      P.record(world, client, iface, {
        src: '0.0.0.0', dst: '255.255.255.255', proto: 'udp', sport: 68, dport: 67,
        len: 342, info: 'BOOTP/DHCP, Request from ' + iface.mac + ', length 300',
        dstMac: 'ff:ff:ff:ff:ff:ff'
      });
    }

    var servers = serversOnSegment(world, client, iface);
    if (!servers.length) {
      client.log('dhclient', 'No DHCPOFFERS received.', 'warning');
      return { err: 'no offers', reason: 'noserver' };
    }

    var srv = servers[0];
    var d = srv.machine.dhcp;

    /* сервер может фильтровать 67/udp — тогда тоже нет ответа */
    var v = srv.machine.fw.evaluate('INPUT', {
      proto: 'udp', dport: 67, src: '0.0.0.0', dst: '255.255.255.255',
      inIface: srv.iface.name, ct: 'NEW'
    });
    if (v !== 'ACCEPT') {
      client.log('dhclient', 'No DHCPOFFERS received.', 'warning');
      return { err: 'no offers', reason: 'filtered' };
    }

    var ip = freeAddress(srv.machine, iface.mac);
    if (!ip) {
      srv.machine.log('dhcpd', 'no free leases on subnet ' + d.subnet, 'err');
      client.log('dhclient', 'No DHCPOFFERS received.', 'warning');
      return { err: 'pool exhausted', reason: 'pool' };
    }

    var lease = {
      ip: ip, prefix: d.prefix, router: d.router, dns: (d.dns || []).slice(),
      domain: d.domain || null, lease: d.leaseTime || 600,
      server: P.firstAddrOf(srv.iface), mac: iface.mac, since: Date.now()
    };
    d.leases[ip] = { mac: iface.mac, since: Date.now(), expires: Date.now() + lease.lease * 1000, host: client.hostname };

    if (world.capture) {
      P.record(world, srv.machine, srv.iface, {
        src: lease.server, dst: '255.255.255.255', proto: 'udp', sport: 67, dport: 68,
        len: 342, info: 'BOOTP/DHCP, Reply, length 300 (offer ' + ip + ')'
      });
    }
    srv.machine.log('dhcpd', 'DHCPOFFER on ' + ip + ' to ' + iface.mac + ' via ' + srv.iface.name);
    srv.machine.log('dhcpd', 'DHCPACK on ' + ip + ' to ' + iface.mac + ' via ' + srv.iface.name);
    return { ok: true, lease: lease };
  }

  /* Применяет полученный lease к стеку клиента (адрес, маршрут, resolv.conf). */
  function apply(world, client, ifname, lease) {
    var iface = client.net.getIface(ifname);
    if (!iface) return false;
    client.net.addAddr(ifname, lease.ip + '/' + lease.prefix, { dynamic: true, validLft: lease.lease });
    if (lease.router) {
      client.net.addRoute({
        dst: 'default', gw: lease.router, dev: ifname, proto: 'dhcp', metric: 100, family: 4
      });
    }
    if (lease.dns && lease.dns.length) {
      client.setResolvConf(lease.dns, lease.domain ? [lease.domain] : []);
    }
    client.log('dhclient', 'bound to ' + lease.ip + ' -- renewal in ' +
      Math.floor(lease.lease / 2) + ' seconds.');
    return true;
  }

  function release(world, client, ifname) {
    var iface = client.net.getIface(ifname);
    if (!iface) return false;
    var dyn = iface.addrs.filter(function (a) { return a.dynamic; });
    dyn.forEach(function (a) {
      client.net.delAddr(ifname, a.ip + '/' + a.prefix);
      world.each(function (m) {
        if (m.dhcp && m.dhcp.leases && m.dhcp.leases[a.ip]) delete m.dhcp.leases[a.ip];
      });
    });
    client.net.routes = client.net.routes.filter(function (r) { return r.proto !== 'dhcp'; });
    client.log('dhclient', 'DHCPRELEASE on ' + ifname + ' to ' + '255.255.255.255' + ' port 67');
    return true;
  }

  NET.dhcp = { request: request, apply: apply, release: release, serversOnSegment: serversOnSegment };
})(window.NET);
