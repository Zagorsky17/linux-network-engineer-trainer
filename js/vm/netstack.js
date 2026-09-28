/*
 * netstack.js — сетевой стек одной машины: интерфейсы, адреса, маршруты,
 * neighbour-кэш, сокеты, sysctl.
 *
 * Здесь нет вывода команд — только состояние и правила его изменения.
 * Все команды (ip, netplan, nmcli, dhclient) работают через этот слой,
 * поэтому не важно, чем пользователь настроил интерфейс: результат один.
 */
(function (NET) {
  'use strict';

  var U = NET.util;

  function NetStack(machine) {
    this.machine = machine;
    this.ifaces = [];
    this.routes = [];
    this.neigh = [];
    this.sockets = [];
    this.nextIfIndex = 1;
    this.sysctl = {
      'net.ipv4.ip_forward': '0',
      'net.ipv4.conf.all.rp_filter': '2',
      'net.ipv4.icmp_echo_ignore_all': '0',
      'net.ipv6.conf.all.disable_ipv6': '0',
      'net.ipv4.tcp_syncookies': '1',
      'net.ipv4.conf.all.send_redirects': '1'
    };
    this.rules = [
      { prio: 0, sel: 'from all', action: 'lookup local' },
      { prio: 32766, sel: 'from all', action: 'lookup main' },
      { prio: 32767, sel: 'from all', action: 'lookup default' }
    ];
  }

  /* ---------- интерфейсы ---------- */

  NetStack.prototype.addIface = function (spec) {
    var i = {
      name: spec.name,
      index: this.nextIfIndex++,
      type: spec.type || 'ether',          // ether|loopback|vlan|bond|bridge|dummy|tun
      state: spec.state || 'DOWN',
      carrier: spec.carrier === undefined ? true : spec.carrier,
      mac: spec.mac || (spec.type === 'loopback' ? '00:00:00:00:00:00' : U.randMac()),
      mtu: spec.mtu || (spec.type === 'loopback' ? 65536 : 1500),
      addrs: [],
      segment: spec.segment || null,       // L2-домен в топологии
      link: spec.link || null,             // родитель для vlan
      vlanId: spec.vlanId || null,
      master: spec.master || null,         // bond/bridge
      slaves: [],
      bondMode: spec.bondMode || null,
      txqueuelen: spec.type === 'loopback' ? 1000 : 1000,
      stats: { rxPackets: U.randInt(1000, 90000), txPackets: U.randInt(1000, 90000), rxBytes: 0, txBytes: 0, rxErrors: 0, txErrors: 0, rxDropped: 0 },
      managedBy: spec.managedBy || null    // 'networkd' | 'NetworkManager'
    };
    i.stats.rxBytes = i.stats.rxPackets * U.randInt(80, 900);
    i.stats.txBytes = i.stats.txPackets * U.randInt(80, 900);
    this.ifaces.push(i);
    (spec.addrs || []).forEach(function (a) {
      this.addAddr(i.name, a.cidr || a, { scope: a.scope, dynamic: a.dynamic, family: a.family });
    }, this);
    if (spec.up) this.setLink(i.name, { up: true });
    return i;
  };

  NetStack.prototype.getIface = function (name) {
    for (var i = 0; i < this.ifaces.length; i++) if (this.ifaces[i].name === name) return this.ifaces[i];
    return null;
  };

  NetStack.prototype.delIface = function (name) {
    var i = this.getIface(name);
    if (!i) return false;
    this.routes = this.routes.filter(function (r) { return r.dev !== name; });
    this.neigh = this.neigh.filter(function (n) { return n.dev !== name; });
    this.ifaces.splice(this.ifaces.indexOf(i), 1);
    return true;
  };

  /* EUI-64: link-local адрес, который ядро добавляет при поднятии интерфейса. */
  function linkLocalFromMac(mac) {
    var p = mac.split(':');
    if (p.length !== 6) return null;
    var first = (parseInt(p[0], 16) ^ 0x02).toString(16);
    if (first.length < 2) first = '0' + first;
    var groups = [
      (first + p[1]).replace(/^0+/, '') || '0',
      (p[2] + 'ff').replace(/^0+/, '') || '0',
      ('fe' + p[3]).replace(/^0+/, '') || '0',
      (p[4] + p[5]).replace(/^0+/, '') || '0'
    ];
    return 'fe80::' + groups.join(':');
  }

  NetStack.prototype.ensureLinkLocal = function (iface) {
    if (!iface || iface.type === 'loopback') return;
    if (this.sysctl['net.ipv6.conf.all.disable_ipv6'] === '1') return;
    var has = iface.addrs.some(function (a) { return a.family === 6 && a.scope === 'link'; });
    if (has) return;
    var ll = linkLocalFromMac(iface.mac);
    if (ll) this.addAddr(iface.name, ll + '/64', { scope: 'link' });
  };

  NetStack.prototype.setLink = function (name, opts) {
    var i = this.getIface(name);
    if (!i) return null;
    if (opts.up === true) {
      i.state = i.carrier ? 'UP' : 'DOWN';
      if (i.state === 'UP') this.ensureLinkLocal(i);
    }
    if (opts.up === false) {
      i.state = 'DOWN';
      // Linux при down удаляет neighbour-записи интерфейса
      this.neigh = this.neigh.filter(function (n) { return n.dev !== name; });
    }
    if (opts.mtu) i.mtu = parseInt(opts.mtu, 10);
    if (opts.mac) i.mac = opts.mac;
    if (opts.carrier !== undefined) {
      i.carrier = opts.carrier;
      if (!i.carrier) i.state = 'DOWN';
    }
    if (opts.master !== undefined) {
      var old = i.master && this.getIface(i.master);
      if (old) old.slaves = old.slaves.filter(function (s) { return s !== name; });
      i.master = opts.master;
      var m = opts.master && this.getIface(opts.master);
      if (m && m.slaves.indexOf(name) < 0) m.slaves.push(name);
    }
    return i;
  };

  /* Интерфейс реально работает (UP + есть линк), включая мастера для slave. */
  NetStack.prototype.operational = function (iface) {
    if (!iface) return false;
    if (iface.state !== 'UP' || !iface.carrier) return false;
    if (iface.type === 'vlan' && iface.link) {
      var parent = this.getIface(iface.link);
      return this.operational(parent);
    }
    if (iface.type === 'bond') {
      var self = this;
      if (!iface.slaves.length) return true;
      return iface.slaves.some(function (s) {
        var sl = self.getIface(s);
        return sl && sl.carrier && sl.state === 'UP';
      });
    }
    return true;
  };

  /* ---------- адреса ---------- */

  NetStack.prototype.addAddr = function (name, cidr, opts) {
    opts = opts || {};
    var i = this.getIface(name);
    if (!i) return { err: 'Cannot find device "' + name + '"' };
    var family = opts.family;
    var ip, prefix;
    if (cidr.indexOf(':') >= 0) {
      family = 6;
      var p6 = cidr.split('/');
      ip = p6[0]; prefix = p6.length > 1 ? parseInt(p6[1], 10) : 64;
      if (!U.expandV6(ip)) return { err: 'invalid prefix for address "' + cidr + '"' };
    } else {
      family = 4;
      var c = U.parseCidr(cidr, 32);
      if (!c) return { err: 'invalid prefix for address "' + cidr + '"' };
      ip = c.ip; prefix = c.prefix;
    }
    var dup = i.addrs.some(function (a) { return a.ip === ip && a.prefix === prefix; });
    if (dup) return { err: 'RTNETLINK answers: File exists' };
    var addr = {
      ip: ip, prefix: prefix, family: family,
      scope: opts.scope || (family === 6 && U.isV6LinkLocal(ip) ? 'link' : (i.type === 'loopback' ? 'host' : 'global')),
      dynamic: !!opts.dynamic,
      label: opts.label || name,
      validLft: opts.validLft || null,
      conflict: false
    };
    i.addrs.push(addr);
    // connected route (proto kernel scope link)
    if (family === 4 && prefix < 32 && i.type !== 'loopback') {
      this.addRoute({
        dst: U.network(ip, prefix), prefix: prefix, dev: name, scope: 'link',
        proto: 'kernel', src: ip, family: 4, metric: opts.metric || 0
      });
    }
    if (family === 6 && prefix < 128 && i.type !== 'loopback') {
      this.addRoute({
        dst: ip.replace(/::[0-9a-f]*$/, '::'), prefix: prefix, dev: name, scope: 'link',
        proto: 'kernel', family: 6, metric: 256
      });
    }
    return { ok: true, addr: addr };
  };

  NetStack.prototype.delAddr = function (name, cidr) {
    var i = this.getIface(name);
    if (!i) return { err: 'Cannot find device "' + name + '"' };
    var parts = cidr.split('/');
    var ip = parts[0];
    var before = i.addrs.length;
    var removed = null;
    i.addrs = i.addrs.filter(function (a) {
      if (a.ip === ip) { removed = a; return false; }
      return true;
    });
    if (i.addrs.length === before) return { err: 'RTNETLINK answers: Cannot assign requested address' };
    var self = this;
    if (removed) {
      this.routes = this.routes.filter(function (r) {
        return !(r.proto === 'kernel' && r.dev === name && r.src === ip);
      });
    }
    return { ok: true };
  };

  NetStack.prototype.flushAddrs = function (name) {
    var i = this.getIface(name);
    if (!i) return false;
    i.addrs = i.addrs.filter(function (a) { return a.family === 6 && a.scope === 'link'; });
    this.routes = this.routes.filter(function (r) {
      return !(r.proto === 'kernel' && r.dev === name);
    });
    return true;
  };

  /* Все адреса машины (для определения «свой IP»). */
  NetStack.prototype.allAddrs = function (family) {
    var out = [];
    this.ifaces.forEach(function (i) {
      i.addrs.forEach(function (a) {
        if (!family || a.family === family) out.push({ iface: i, addr: a });
      });
    });
    return out;
  };

  NetStack.prototype.ownsIP = function (ip) {
    var found = null;
    this.ifaces.forEach(function (i) {
      i.addrs.forEach(function (a) { if (a.ip === ip) found = { iface: i, addr: a }; });
    });
    return found;
  };

  /* Основной IPv4-адрес (для вывода в prompt, ssh, логах). */
  NetStack.prototype.primaryIP = function () {
    var best = null;
    this.ifaces.forEach(function (i) {
      if (i.type === 'loopback') return;
      i.addrs.forEach(function (a) {
        if (a.family === 4 && !best) best = a.ip;
      });
    });
    return best;
  };

  /* ---------- маршруты ---------- */

  NetStack.prototype.addRoute = function (spec) {
    var r = {
      dst: spec.dst === 'default' ? '0.0.0.0' : spec.dst,
      prefix: spec.dst === 'default' ? 0 : (spec.prefix === undefined ? 32 : spec.prefix),
      gw: spec.gw || null,
      dev: spec.dev || null,
      metric: spec.metric === undefined ? 0 : spec.metric,
      proto: spec.proto || 'static',
      scope: spec.scope || (spec.gw ? 'global' : 'link'),
      src: spec.src || null,
      table: spec.table || 'main',
      family: spec.family || (String(spec.dst).indexOf(':') >= 0 ? 6 : 4),
      onlink: !!spec.onlink
    };
    var dup = this.routes.some(function (x) {
      return x.dst === r.dst && x.prefix === r.prefix && x.gw === r.gw &&
        x.dev === r.dev && x.metric === r.metric && x.table === r.table;
    });
    if (dup) return { err: 'RTNETLINK answers: File exists' };
    /* шлюз обязан быть в подсети интерфейса: иначе его MAC не узнать через ARP
       (именно так неверная маска «отрезает» шлюз) */
    if (r.gw && r.dev && !r.onlink && r.family === 4) {
      var devIface = this.getIface(r.dev);
      var onLink = devIface && devIface.addrs.some(function (a) {
        return a.family === 4 && U.sameSubnet(a.ip, r.gw, a.prefix);
      });
      if (devIface && !onLink) return { err: 'Error: Nexthop has invalid gateway.' };
    }
    if (r.gw && !r.dev) {
      var via = this.ifaceForNextHop(r.gw);
      if (!via && !r.onlink) return { err: 'RTNETLINK answers: Network is unreachable' };
      r.dev = via ? via.name : null;
    }
    this.routes.push(r);
    return { ok: true, route: r };
  };

  NetStack.prototype.delRoute = function (match) {
    var dst = match.dst === 'default' ? '0.0.0.0' : match.dst;
    var prefix = match.dst === 'default' ? 0 : match.prefix;
    var idx = -1;
    for (var i = 0; i < this.routes.length; i++) {
      var r = this.routes[i];
      if (r.dst !== dst) continue;
      if (prefix !== undefined && r.prefix !== prefix) continue;
      if (match.gw && r.gw !== match.gw) continue;
      if (match.dev && r.dev !== match.dev) continue;
      idx = i; break;
    }
    if (idx < 0) return { err: 'RTNETLINK answers: No such process' };
    this.routes.splice(idx, 1);
    return { ok: true };
  };

  NetStack.prototype.flushRoutes = function (family) {
    this.routes = this.routes.filter(function (r) {
      return (family && r.family !== family) || r.proto === 'kernel';
    });
  };

  /* Интерфейс, через который next-hop достижим напрямую (совпадение подсети). */
  NetStack.prototype.ifaceForNextHop = function (ip) {
    var found = null, self = this;
    var v6 = ip.indexOf(':') >= 0;
    this.ifaces.forEach(function (i) {
      i.addrs.forEach(function (a) {
        if (found) return;
        if (v6 && a.family === 6 && U.v6SameNet(a.ip, ip, a.prefix)) found = i;
        if (!v6 && a.family === 4 && U.sameSubnet(a.ip, ip, a.prefix)) found = i;
      });
    });
    return found;
  };

  /*
   * Поиск маршрута: longest prefix match, при равенстве — меньшая метрика.
   * Маршруты через неработающий интерфейс игнорируются (в Linux — linkdown).
   */
  NetStack.prototype.lookupRoute = function (dst, opts) {
    opts = opts || {};
    var family = dst.indexOf(':') >= 0 ? 6 : 4;
    var self = this;
    var table = opts.table || 'main';
    var candidates = this.routes.filter(function (r) {
      if (r.family !== family || r.table !== table) return false;
      if (family === 4) {
        if (!U.isIPv4(dst)) return false;
        return r.prefix === 0 || U.network(dst, r.prefix) === U.network(r.dst, r.prefix);
      }
      return r.prefix === 0 || U.v6SameNet(r.dst, dst, r.prefix);
    }).filter(function (r) {
      var dev = r.dev ? self.getIface(r.dev) : null;
      if (r.dev && !dev) return false;
      return !r.dev || self.operational(dev);
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      if (b.prefix !== a.prefix) return b.prefix - a.prefix;
      return a.metric - b.metric;
    });
    var route = candidates[0];
    var iface = route.dev ? this.getIface(route.dev) : this.ifaceForNextHop(route.gw || dst);
    var src = route.src;
    if (!src && iface) {
      for (var i = 0; i < iface.addrs.length; i++) {
        var a = iface.addrs[i];
        if (a.family === family && a.scope !== 'link') { src = a.ip; break; }
      }
      if (!src) {
        for (var j = 0; j < iface.addrs.length; j++) {
          if (iface.addrs[j].family === family) { src = iface.addrs[j].ip; break; }
        }
      }
    }
    return { route: route, iface: iface, gw: route.gw, src: src, nextHop: route.gw || dst };
  };

  NetStack.prototype.defaultRoute = function (family) {
    var f = family || 4;
    var list = this.routes.filter(function (r) { return r.prefix === 0 && r.family === f; });
    list.sort(function (a, b) { return a.metric - b.metric; });
    return list[0] || null;
  };

  /* ---------- neighbour (ARP/NDP) кэш ---------- */

  NetStack.prototype.setNeigh = function (ip, dev, lladdr, state) {
    var found = null;
    for (var i = 0; i < this.neigh.length; i++) {
      if (this.neigh[i].ip === ip && this.neigh[i].dev === dev) found = this.neigh[i];
    }
    if (!found) {
      found = { ip: ip, dev: dev, lladdr: lladdr || null, state: state || 'INCOMPLETE', ts: Date.now() };
      this.neigh.push(found);
    } else {
      found.lladdr = lladdr === undefined ? found.lladdr : lladdr;
      found.state = state || found.state;
      found.ts = Date.now();
    }
    return found;
  };

  NetStack.prototype.delNeigh = function (ip, dev) {
    this.neigh = this.neigh.filter(function (n) {
      return !(n.ip === ip && (!dev || n.dev === dev));
    });
  };

  NetStack.prototype.flushNeigh = function (dev) {
    this.neigh = this.neigh.filter(function (n) { return dev && n.dev !== dev; });
  };

  /* ---------- сокеты ---------- */

  NetStack.prototype.listen = function (spec) {
    var s = {
      proto: spec.proto || 'tcp',
      addr: spec.addr || '0.0.0.0',
      port: spec.port,
      state: 'LISTEN',
      peerAddr: '0.0.0.0', peerPort: '*',
      pid: spec.pid || null,
      process: spec.process || null,
      unit: spec.unit || null,
      users: spec.users || 0
    };
    this.sockets.push(s);
    return s;
  };

  NetStack.prototype.establish = function (spec) {
    var s = {
      proto: spec.proto || 'tcp',
      addr: spec.addr, port: spec.port,
      state: 'ESTAB',
      peerAddr: spec.peerAddr, peerPort: spec.peerPort,
      pid: spec.pid || null, process: spec.process || null,
      unit: spec.unit || null, ts: Date.now()
    };
    this.sockets.push(s);
    /* Без вытеснения список ESTAB рос бы бесконечно от каждого curl/nc
       и засорял вывод ss. Держим только свежие и не больше лимита. */
    this.pruneEstablished();
    return s;
  };

  NetStack.prototype.closeUnitSockets = function (unit) {
    this.sockets = this.sockets.filter(function (s) { return s.unit !== unit; });
  };

  NetStack.prototype.listening = function (port, proto, ip) {
    proto = proto || 'tcp';
    var list = this.sockets.filter(function (s) {
      if (s.state !== 'LISTEN' || s.proto !== proto || Number(s.port) !== Number(port)) return false;
      if (!ip) return true;
      return s.addr === '0.0.0.0' || s.addr === '*' || s.addr === '::' || s.addr === ip ||
        (s.addr === '127.0.0.1' && (ip === '127.0.0.1' || ip === 'localhost'));
    });
    return list[0] || null;
  };

  NetStack.prototype.pruneEstablished = function (maxAgeMs) {
    var now = Date.now();
    var age = maxAgeMs === undefined ? 120000 : maxAgeMs;
    this.sockets = this.sockets.filter(function (s) {
      return s.state === 'LISTEN' || !s.ts || (now - s.ts) < age;
    });
    var limit = U.LIMITS.sockets;
    if (this.sockets.length > limit) {
      var listening = this.sockets.filter(function (s) { return s.state === 'LISTEN'; });
      var rest = this.sockets.filter(function (s) { return s.state !== 'LISTEN'; });
      this.sockets = listening.concat(rest.slice(-(limit - listening.length)));
    }
  };

  /* ---------- снапшот ---------- */

  NetStack.prototype.snapshot = function () {
    return U.clone({
      ifaces: this.ifaces, routes: this.routes, neigh: this.neigh,
      sockets: this.sockets, sysctl: this.sysctl, nextIfIndex: this.nextIfIndex, rules: this.rules
    });
  };

  NetStack.prototype.restore = function (s) {
    var c = U.clone(s);
    this.ifaces = c.ifaces; this.routes = c.routes; this.neigh = c.neigh;
    this.sockets = c.sockets; this.sysctl = c.sysctl; this.nextIfIndex = c.nextIfIndex;
    this.rules = c.rules || this.rules;
  };

  NET.NetStack = NetStack;
})(window.NET);
