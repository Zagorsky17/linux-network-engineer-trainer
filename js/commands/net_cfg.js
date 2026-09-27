/*
 * net_cfg.js — постоянная конфигурация: netplan, nmcli, dhclient.
 * Ключевой учебный момент: `ip addr add` живёт до перезагрузки,
 * а netplan/nmcli записывают конфигурацию, которая переживёт reboot.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;

  reg({
    name: 'netplan', category: 'netcfg', summary: 'конфигурация сети Ubuntu',
    usage: 'netplan {apply|try|generate|get|status|info}',
    complete: function (ctx, word, argv) {
      if (argv.length <= 1) return ['apply', 'try', 'generate', 'get', 'status', 'info'];
      return [];
    },
    run: function (ctx) {
      var sub = ctx.argv[0];
      var m = ctx.machine;
      if (!sub) {
        ctx.errLine('usage: netplan [-h] [--debug] {apply,generate,get,info,set,status,try}');
        return 1;
      }
      if (sub === 'info') {
        ctx.line('netplan.io:');
        ctx.line('  website: https://netplan.io/');
        ctx.line('  features:');
        ctx.line('  - dhcp-use-domains');
        ctx.line('  - ipv6-mtu');
        return 0;
      }

      var loaded = NET.netcfg.loadFiles(m);
      if (loaded.errors.length) {
        loaded.errors.forEach(function (e) { ctx.errLine(e); });
        if (sub === 'apply' || sub === 'generate' || sub === 'try') return 1;
      }

      if (sub === 'get') {
        var doc = loaded.doc;
        var key = ctx.argv[1];
        var node = doc.network;
        if (key && key !== 'all') {
          key.split('.').forEach(function (k) { node = node ? node[k] : null; });
        }
        ctx.out(NET.netcfg.renderYaml(node === null || node === undefined ? {} : node) + '\n');
        return 0;
      }

      if (sub === 'status') {
        ctx.line('     Online state: ' + (m.net.defaultRoute(4) ? 'online' : 'offline') + ',');
        ctx.line('    DNS Addresses: ' + (NET.dns.resolvers(m).join(', ') || '—'));
        ctx.line('');
        m.net.ifaces.forEach(function (i) {
          ctx.line('●  ' + i.index + ': ' + i.name + ' ' + (i.type === 'loopback' ? 'loopback' : 'ethernet') +
            ' ' + (i.state === 'UP' ? 'UP' : 'DOWN') + ' (' + (i.managedBy || 'unmanaged') + ')');
          i.addrs.forEach(function (a) {
            ctx.line('      Addresses: ' + a.ip + '/' + a.prefix + (a.dynamic ? ' (dhcp)' : ''));
          });
          var routes = m.net.routes.filter(function (r) { return r.dev === i.name && r.proto !== 'kernel'; });
          routes.forEach(function (r) {
            ctx.line('         Routes: ' + (r.prefix === 0 ? 'default' : r.dst + '/' + r.prefix) +
              (r.gw ? ' via ' + r.gw : '') + ' (' + r.proto + ')');
          });
          ctx.line('');
        });
        return 0;
      }

      if (sub === 'generate') {
        var errs = NET.netcfg.validate(loaded.doc);
        errs.forEach(function (e) { ctx.errLine(e); });
        return errs.filter(function (e) { return e.indexOf('WARNING') < 0; }).length ? 1 : 0;
      }

      if (sub === 'apply' || sub === 'try') {
        if (!ctx.isRoot) {
          ctx.errLine('netplan apply: Permission denied, are you root?');
          return 1;
        }
        var res = NET.netcfg.apply(ctx.world, m, loaded.doc);
        (res.errors || []).forEach(function (e) { ctx.errLine(e); });
        if (!res.ok) return 1;
        if (sub === 'try') {
          ctx.line('Do you want to keep these settings?');
          ctx.line('');
          ctx.line('Press ENTER before the timeout to accept the new configuration');
          ctx.line('');
          ctx.line('Configuration accepted.');
        }
        NET.bus.emit('netplan:applied', { machine: m.name });
        return 0;
      }

      if (sub === 'set') {
        ctx.errLine('netplan set: в тренажёре правьте /etc/netplan/*.yaml напрямую (nano/sed/cat > file)');
        return 1;
      }
      ctx.errLine('netplan: unknown command ' + sub);
      return 1;
    }
  });

  /* ---------- nmcli ---------- */

  function findConn(m, name) {
    for (var i = 0; i < m.nm.connections.length; i++) {
      if (m.nm.connections[i].name === name || m.nm.connections[i].device === name) return m.nm.connections[i];
    }
    return null;
  }

  reg({
    name: 'nmcli', category: 'netcfg', summary: 'NetworkManager из CLI',
    usage: 'nmcli {general|networking|device|connection} [COMMAND]',
    complete: function (ctx, word, argv, h) {
      if (argv.length <= 1) return ['general', 'networking', 'device', 'connection', 'dev', 'con', 'c', 'd', 'g'];
      var obj = argv[1];
      if (/^(d|dev|device)$/.test(obj)) return ['status', 'show', 'connect', 'disconnect'];
      if (/^(c|con|connection)$/.test(obj)) return ['show', 'up', 'down', 'add', 'modify', 'mod', 'delete', 'reload'];
      return [];
    },
    run: function (ctx) {
      var m = ctx.machine;
      var argv = ctx.argv.slice();
      var obj = argv.shift();
      if (!obj) {
        ctx.line('Usage: nmcli [OPTIONS] OBJECT { COMMAND | help }');
        ctx.line('OBJECT := { general | networking | radio | connection | device }');
        return 0;
      }
      if (!m.services.get('NetworkManager') || !m.services.isActive('NetworkManager')) {
        ctx.errLine('Error: NetworkManager is not running.');
        return 8;
      }

      if (/^(g|general)$/.test(obj)) {
        var online = !!m.net.defaultRoute(4);
        ctx.line(U.padRight('STATE', 12) + U.padRight('CONNECTIVITY', 14) + U.padRight('WIFI-HW', 9) +
          U.padRight('WIFI', 7) + U.padRight('WWAN-HW', 9) + 'WWAN');
        ctx.line(U.padRight(online ? 'connected' : 'disconnected', 12) +
          U.padRight(online ? 'full' : 'none', 14) + U.padRight('enabled', 9) +
          U.padRight('enabled', 7) + U.padRight('enabled', 9) + 'enabled');
        return 0;
      }

      if (/^(n|networking)$/.test(obj)) {
        ctx.line(m.net.ifaces.some(function (i) { return i.state === 'UP' && i.type !== 'loopback'; })
          ? 'enabled' : 'disabled');
        return 0;
      }

      if (/^(d|dev|device)$/.test(obj)) {
        var sub = argv.shift() || 'status';
        if (sub === 'status') {
          ctx.line(U.padRight('DEVICE', 14) + U.padRight('TYPE', 12) + U.padRight('STATE', 16) + 'CONNECTION');
          m.net.ifaces.forEach(function (i) {
            var conn = m.nm.connections.filter(function (c) { return c.device === i.name && c.active; })[0];
            var state = i.type === 'loopback' ? 'unmanaged'
              : (conn ? 'connected' : (i.state === 'UP' ? 'connected (externally)' : 'disconnected'));
            ctx.line(U.padRight(i.name, 14) + U.padRight(i.type === 'loopback' ? 'loopback' : 'ethernet', 12) +
              U.padRight(state, 16) + (conn ? conn.name : '--'));
          });
          return 0;
        }
        if (sub === 'show') {
          var dev = argv[0];
          m.net.ifaces.forEach(function (i) {
            if (dev && i.name !== dev) return;
            ctx.line('GENERAL.DEVICE:                         ' + i.name);
            ctx.line('GENERAL.TYPE:                           ' + (i.type === 'loopback' ? 'loopback' : 'ethernet'));
            ctx.line('GENERAL.HWADDR:                         ' + i.mac.toUpperCase());
            ctx.line('GENERAL.MTU:                            ' + i.mtu);
            ctx.line('GENERAL.STATE:                          ' + (i.state === 'UP' ? '100 (connected)' : '30 (disconnected)'));
            i.addrs.filter(function (a) { return a.family === 4; }).forEach(function (a, n) {
              ctx.line('IP4.ADDRESS[' + (n + 1) + ']:                        ' + a.ip + '/' + a.prefix);
            });
            var def = m.net.routes.filter(function (r) { return r.prefix === 0 && r.dev === i.name; })[0];
            if (def) ctx.line('IP4.GATEWAY:                            ' + def.gw);
            NET.dns.resolvers(m).forEach(function (s, n) {
              ctx.line('IP4.DNS[' + (n + 1) + ']:                            ' + s);
            });
            ctx.line('');
          });
          return 0;
        }
        if (sub === 'connect' || sub === 'disconnect') {
          if (!ctx.isRoot) return ctx.fail('Error: Failed to ' + sub + ' device: Not authorized', 4);
          var d = argv[0];
          if (!m.net.getIface(d)) return ctx.fail('Error: Device \'' + d + '\' not found.', 10);
          m.net.setLink(d, { up: sub === 'connect' });
          var c = findConn(m, d);
          if (c) { if (sub === 'connect') NET.netcfg.nmApply(ctx.world, m, c); else NET.netcfg.nmDown(m, c); }
          ctx.line('Device \'' + d + '\' successfully ' + (sub === 'connect' ? 'activated' : 'disconnected') + '.');
          return 0;
        }
        return ctx.fail('Error: unknown device command \'' + sub + '\'.', 2);
      }

      if (/^(c|con|connection)$/.test(obj)) {
        var csub = argv.shift() || 'show';
        if (csub === 'show') {
          if (argv[0] && argv[0] !== '--active') {
            var conn = findConn(m, argv[0]);
            if (!conn) return ctx.fail('Error: ' + argv[0] + ' - no such connection profile.', 10);
            ctx.line('connection.id:                          ' + conn.name);
            ctx.line('connection.interface-name:              ' + conn.device);
            ctx.line('connection.autoconnect:                 ' + (conn.autoconnect === false ? 'no' : 'yes'));
            ctx.line('ipv4.method:                            ' + conn.method);
            ctx.line('ipv4.addresses:                         ' + (conn.addresses || []).join(', '));
            ctx.line('ipv4.gateway:                           ' + (conn.gateway || '--'));
            ctx.line('ipv4.dns:                               ' + (conn.dns || []).join(','));
            return 0;
          }
          ctx.line(U.padRight('NAME', 20) + U.padRight('UUID', 38) + U.padRight('TYPE', 10) + 'DEVICE');
          m.nm.connections.forEach(function (c) {
            if (argv[0] === '--active' && !c.active) return;
            ctx.line(U.padRight(c.name, 20) + U.padRight(c.uuid || U.uid('uuid'), 38) +
              U.padRight('ethernet', 10) + (c.active ? c.device : '--'));
          });
          return 0;
        }
        if (csub === 'up' || csub === 'down') {
          if (!ctx.isRoot) return ctx.fail('Error: Not authorized to control networking.', 4);
          var cn = findConn(m, argv[0]);
          if (!cn) return ctx.fail('Error: unknown connection \'' + argv[0] + '\'.', 10);
          if (csub === 'up') {
            var r = NET.netcfg.nmApply(ctx.world, m, cn);
            if (r.err) { ctx.errLine(r.err); return 4; }
            ctx.line('Connection successfully activated (D-Bus active path: /org/freedesktop/NetworkManager/ActiveConnection/' + U.randInt(1, 20) + ')');
          } else {
            NET.netcfg.nmDown(m, cn);
            ctx.line('Connection \'' + cn.name + '\' successfully deactivated.');
          }
          return 0;
        }
        if (csub === 'add') {
          if (!ctx.isRoot) return ctx.fail('Error: Not authorized.', 4);
          var spec = { name: null, device: null, method: 'auto', addresses: [], dns: [], autoconnect: true };
          for (var i = 0; i < argv.length; i++) {
            var k = argv[i], v = argv[i + 1];
            if (k === 'con-name') spec.name = v;
            else if (k === 'ifname') spec.device = v;
            else if (k === 'ipv4.method') spec.method = v;
            else if (k === 'ipv4.addresses') { spec.addresses = v.split(','); spec.method = 'manual'; }
            else if (k === 'ipv4.gateway') spec.gateway = v;
            else if (k === 'ipv4.dns') spec.dns = v.split(/[ ,]/);
            else if (k === 'autoconnect') spec.autoconnect = v === 'yes';
          }
          if (!spec.name) spec.name = (spec.device || 'con') + '-' + U.randInt(1, 99);
          spec.uuid = U.uid('nm');
          m.nm.connections.push(spec);
          ctx.line('Connection \'' + spec.name + '\' (' + spec.uuid + ') successfully added.');
          return 0;
        }
        if (csub === 'mod' || csub === 'modify') {
          if (!ctx.isRoot) return ctx.fail('Error: Not authorized.', 4);
          var target = argv.shift();
          var c2 = findConn(m, target);
          if (!c2) return ctx.fail('Error: unknown connection \'' + target + '\'.', 10);
          for (var j = 0; j < argv.length; j += 2) {
            var key = argv[j], val = argv[j + 1];
            if (key === 'ipv4.method') c2.method = val;
            else if (key === 'ipv4.addresses') { c2.addresses = val.split(','); }
            else if (key === 'ipv4.gateway') c2.gateway = val;
            else if (key === 'ipv4.dns') c2.dns = val.split(/[ ,]/);
            else if (key === 'ipv4.dns-search') c2['dns-search'] = val.split(',');
            else if (key === 'connection.autoconnect') c2.autoconnect = val === 'yes';
            else if (key === '802-3-ethernet.mtu' || key === 'ethernet.mtu') c2.mtu = Number(val);
          }
          ctx.line('');
          return 0;
        }
        if (csub === 'delete') {
          var idx = m.nm.connections.indexOf(findConn(m, argv[0]));
          if (idx < 0) return ctx.fail('Error: unknown connection \'' + argv[0] + '\'.', 10);
          m.nm.connections.splice(idx, 1);
          ctx.line('Connection \'' + argv[0] + '\' successfully deleted.');
          return 0;
        }
        if (csub === 'reload') return 0;
        return ctx.fail('Error: unknown connection command \'' + csub + '\'.', 2);
      }

      ctx.errLine('Error: Object \'' + obj + '\' is unknown, try \'nmcli help\'.');
      return 2;
    }
  });

  /* ---------- dhclient ---------- */

  reg({
    name: 'dhclient', category: 'netcfg', summary: 'получить адрес по DHCP',
    usage: 'dhclient [-r] [-v] IFACE',
    complete: function (ctx, word, argv, h) { return h.ifaces(ctx); },
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['r', 'v', '1', '4', '6'] });
      var dev = p.rest[0];
      if (!ctx.isRoot) return ctx.fail('dhclient: Permission denied — запустите через sudo', 1);
      if (!dev) {
        var up = ctx.machine.net.ifaces.filter(function (i) { return i.type === 'ether'; })[0];
        dev = up ? up.name : null;
      }
      if (!dev || !ctx.machine.net.getIface(dev)) {
        return ctx.fail('dhclient: Can\'t open /dev/' + dev + ': No such device', 1);
      }
      if (p.flags.r) {
        NET.dhcp.release(ctx.world, ctx.machine, dev);
        if (p.flags.v) ctx.line('Released address on ' + dev);
        return 0;
      }
      var res = NET.dhcp.request(ctx.world, ctx.machine, dev);
      return ctx.sleep(res.ok ? 400 : 1600).then(function () {
        if (p.flags.v) {
          ctx.errLine('Internet Systems Consortium DHCP Client 4.4.3-P1');
          ctx.errLine('Listening on LPF/' + dev + '/' + ctx.machine.net.getIface(dev).mac);
        }
        if (!res.ok) {
          ctx.errLine('DHCPDISCOVER on ' + dev + ' to 255.255.255.255 port 67 interval 3');
          ctx.errLine('DHCPDISCOVER on ' + dev + ' to 255.255.255.255 port 67 interval 8');
          ctx.errLine('No DHCPOFFERS received.');
          ctx.errLine('No working leases in persistent database - sleeping.');
          return 2;
        }
        NET.dhcp.apply(ctx.world, ctx.machine, dev, res.lease);
        ctx.errLine('DHCPDISCOVER on ' + dev + ' to 255.255.255.255 port 67 interval 3');
        ctx.errLine('DHCPOFFER of ' + res.lease.ip + ' from ' + res.lease.server);
        ctx.errLine('DHCPREQUEST for ' + res.lease.ip + ' on ' + dev + ' to 255.255.255.255 port 67');
        ctx.errLine('DHCPACK of ' + res.lease.ip + ' from ' + res.lease.server);
        ctx.errLine('bound to ' + res.lease.ip + ' -- renewal in ' + Math.floor(res.lease.lease / 2) + ' seconds.');
        return 0;
      });
    }
  });

  /* ---------- редактор конфигов ---------- */

  reg({
    name: 'nano', aliases: ['vi', 'vim', 'edit'], category: 'netcfg',
    summary: 'открыть файл в редакторе', usage: 'nano FILE',
    complete: function (ctx, word, argv, h) { return h.path(ctx, word); },
    run: function (ctx) {
      var f = ctx.argv[0];
      if (!f) return ctx.usageError('Usage: nano [FILE]');
      var abs = ctx.resolve(f);
      var node = ctx.vfs.get(abs, ctx.fsctx);
      var content = '';
      if (node) {
        if (!ctx.vfs.can(node, ctx.fsctx, 'r')) return ctx.fail('nano: ' + f + ': Permission denied');
        content = ctx.vfs.contentOf(node);
      }
      if (ctx.session.onEditor && ctx.streaming) {
        ctx.session.onEditor(abs, content, ctx.user);
        return 0;
      }
      ctx.out(content);
      return 0;
    }
  });
})(window.NET);
