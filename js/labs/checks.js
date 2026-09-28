/*
 * checks.js — библиотека предикатов проверки состояния мира.
 * Проверяется результат (сеть работает), а не способ: пользователь волен
 * чинить через ip, netplan или nmcli — лаборатория засчитает любой рабочий путь.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var P = NET.packet;

  function mk(title, fn) { return { title: title, run: fn }; }

  var C = {};

  C.canPing = function (from, ip, label) {
    return mk((label || 'ICMP') + ': ' + from + ' → ' + ip, function (world) {
      var m = world.get(from);
      if (!m) return { ok: false, detail: 'нет хоста ' + from };
      var r = P.icmpEcho(world, m, ip, { size: 56 });
      return { ok: !!r.ok, detail: r.ok ? null : describe(r) };
    });
  };

  C.cannotPing = function (from, ip, label) {
    return mk((label || 'не должно пинговаться') + ': ' + from + ' → ' + ip, function (world) {
      var m = world.get(from);
      var r = P.icmpEcho(world, m, ip, { size: 56 });
      return { ok: !r.ok, detail: r.ok ? 'связь есть, а не должно быть' : null };
    });
  };

  /* opts.srcIP — с какого адреса подключаться (у нарушителя их несколько). */
  C.tcpOpen = function (from, ip, port, label, opts) {
    opts = opts || {};
    return mk((label || 'TCP') + ' ' + from + (opts.srcIP ? ' (' + opts.srcIP + ')' : '') + ' → ' + ip + ':' + port,
      function (world) {
        var m = world.get(from);
        if (!m) return { ok: false, detail: 'нет хоста ' + from };
        var r = P.tcpConnect(world, m, ip, port, { srcIP: opts.srcIP });
        return { ok: !!r.ok, detail: r.ok ? null : describe(r) };
      });
  };

  /* Соединение по имени — как у приложения: системный резолвер (/etc/hosts, DNS), затем TCP. */
  C.tcpOpenByName = function (from, name, port, label) {
    return mk((label || 'TCP') + ' ' + from + ' → ' + name + ':' + port, function (world) {
      var m = world.get(from);
      if (!m) return { ok: false, detail: 'нет хоста ' + from };
      var res = NET.dns.resolve(world, m, name, { type: 'A' });
      if (!res.ip) return { ok: false, detail: 'имя не разрешается (' + res.status + ')' };
      var r = P.tcpConnect(world, m, res.ip, port, {});
      return { ok: !!r.ok, detail: r.ok ? null : res.ip + ': ' + describe(r) };
    });
  };

  C.routeExists = function (host, cidr, opts) {
    opts = opts || {};
    return mk('Маршрут ' + cidr + ' на ' + host + (opts.via ? ' через ' + opts.via : ''), function (world) {
      var m = world.get(host);
      var c = cidr === 'default' ? { ip: '0.0.0.0', prefix: 0 } : U.parseCidr(cidr);
      if (!m || !c) return { ok: false, detail: 'некорректная проверка' };
      var found = m.net.routes.filter(function (r) {
        return r.dst === c.ip && r.prefix === c.prefix && (!opts.via || r.gw === opts.via);
      });
      if (!found.length) return { ok: false, detail: 'маршрута нет в таблице' };
      var dev = found[0].dev ? m.net.getIface(found[0].dev) : null;
      if (dev && !m.net.operational(dev)) return { ok: false, detail: 'маршрут есть, но интерфейс ' + dev.name + ' down' };
      return { ok: true };
    });
  };

  C.defaultVia = function (host, gw) {
    return mk('Шлюз по умолчанию на ' + host + ' = ' + gw, function (world) {
      var m = world.get(host);
      var def = m && m.net.defaultRoute(4);
      if (!def) return { ok: false, detail: 'default route отсутствует' };
      if (def.gw !== gw) return { ok: false, detail: 'сейчас ' + (def.gw || 'без via') };
      return { ok: true };
    });
  };

  C.ifaceUp = function (host, name) {
    return mk('Интерфейс ' + name + ' на ' + host + ' поднят', function (world) {
      var m = world.get(host);
      var i = m && m.net.getIface(name);
      if (!i) return { ok: false, detail: 'нет такого интерфейса' };
      if (!i.carrier) return { ok: false, detail: 'нет линка (NO-CARRIER)' };
      return { ok: i.state === 'UP', detail: i.state === 'UP' ? null : 'состояние ' + i.state };
    });
  };

  C.hasAddr = function (host, iface, cidr) {
    return mk('Адрес ' + cidr + ' на ' + host + ':' + iface, function (world) {
      var m = world.get(host);
      var i = m && m.net.getIface(iface);
      if (!i) return { ok: false, detail: 'нет интерфейса ' + iface };
      var c = U.parseCidr(cidr);
      var ok = i.addrs.some(function (a) { return a.ip === c.ip && a.prefix === c.prefix; });
      var cur = i.addrs.filter(function (a) { return a.family === 4; })
        .map(function (a) { return a.ip + '/' + a.prefix; }).join(', ');
      return { ok: ok, detail: ok ? null : 'сейчас: ' + (cur || 'адресов нет') };
    });
  };

  C.addrInSubnet = function (host, iface, subnet) {
    return mk('Адрес ' + host + ':' + iface + ' из подсети ' + subnet, function (world) {
      var m = world.get(host);
      var i = m && m.net.getIface(iface);
      if (!i) return { ok: false, detail: 'нет интерфейса' };
      var c = U.parseCidr(subnet);
      var ok = i.addrs.some(function (a) {
        return a.family === 4 && U.inSubnet(a.ip, subnet) && a.prefix === c.prefix;
      });
      return { ok: ok, detail: ok ? null : 'нет адреса с верной маской' };
    });
  };

  C.addrIsDynamic = function (host, iface) {
    return mk('Адрес на ' + host + ':' + iface + ' получен по DHCP', function (world) {
      var m = world.get(host);
      var i = m && m.net.getIface(iface);
      if (!i) return { ok: false, detail: 'нет интерфейса' };
      var ok = i.addrs.some(function (a) { return a.family === 4 && a.dynamic; });
      return { ok: ok, detail: ok ? null : 'динамического адреса нет' };
    });
  };

  C.portListening = function (host, port, proto, addr) {
    return mk('На ' + host + ' слушается ' + (proto || 'tcp') + '/' + port, function (world) {
      var m = world.get(host);
      var s = m && m.net.listening(port, proto || 'tcp', addr);
      if (!s) return { ok: false, detail: 'порт не слушается' };
      if (addr && s.addr !== addr && s.addr !== '0.0.0.0') {
        return { ok: false, detail: 'слушается только на ' + s.addr };
      }
      return { ok: true };
    });
  };

  C.serviceActive = function (host, unit) {
    return mk('Сервис ' + unit + ' активен на ' + host, function (world) {
      var m = world.get(host);
      var u = m && m.services.get(unit);
      if (!u) return { ok: false, detail: 'юнит не найден' };
      return { ok: u.state === 'active', detail: u.state === 'active' ? null : 'состояние ' + u.state };
    });
  };

  C.resolves = function (host, name, expectIp) {
    return mk('DNS на ' + host + ': ' + name + ' → ' + (expectIp || 'любой адрес'), function (world) {
      var m = world.get(host);
      var r = NET.dns.resolve(world, m, name, { type: 'A' });
      if (!r.ip) return { ok: false, detail: 'статус ' + r.status };
      if (expectIp && r.ip !== expectIp) return { ok: false, detail: 'получено ' + r.ip };
      return { ok: true };
    });
  };

  C.mtuIs = function (host, iface, mtu) {
    return mk('MTU ' + host + ':' + iface + ' = ' + mtu, function (world) {
      var m = world.get(host);
      var i = m && m.net.getIface(iface);
      if (!i) return { ok: false, detail: 'нет интерфейса' };
      return { ok: i.mtu === mtu, detail: i.mtu === mtu ? null : 'сейчас ' + i.mtu };
    });
  };

  /* Большой пакет с DF проходит — значит MTU по пути согласован. */
  C.pathMtuOk = function (from, ip, size) {
    return mk('Большой пакет (' + size + ' байт, DF) доходит до ' + ip, function (world) {
      var m = world.get(from);
      var r = P.icmpEcho(world, m, ip, { size: size, df: true });
      return { ok: !!r.ok, detail: r.ok ? null : describe(r) };
    });
  };

  C.firewallAllows = function (host, port, proto) {
    return mk('Firewall на ' + host + ' пропускает ' + (proto || 'tcp') + '/' + port, function (world) {
      var m = world.get(host);
      var ok = m.fw.allowsInput(proto || 'tcp', port, '192.168.10.30');
      return { ok: ok, detail: ok ? null : 'пакет отбрасывается фильтром' };
    });
  };

  /*
   * Конфигурация переживает перезагрузку: делаем снапшот мира, перезагружаем
   * машину, прогоняем вложенные проверки и возвращаем всё обратно.
   */
  C.survivesReboot = function (host, inner) {
    return mk('Конфигурация ' + host + ' сохранена (переживает reboot)', function (world) {
      var snap = world.snapshot();
      var m = world.get(host);
      var detail = null, ok = true;
      try {
        m.reboot();
        for (var i = 0; i < inner.length; i++) {
          var r = inner[i].run(world);
          if (!r.ok) { ok = false; detail = inner[i].title + ' — ' + (r.detail || 'не выполнено'); break; }
        }
      } catch (e) {
        ok = false; detail = 'ошибка проверки: ' + e.message;
      }
      world.restore(snap);
      return { ok: ok, detail: ok ? null : 'после перезагрузки: ' + detail };
    });
  };

  /* Пользователь действительно применил диагностику, а не угадал. */
  C.usedCommand = function (re, title) {
    return mk(title || ('Использована команда ' + re), function (world, engine) {
      var used = (engine && engine.commands() || []).some(function (c) { return re.test(c.line); });
      return { ok: used, detail: used ? null : 'команда не выполнялась' };
    });
  };

  /* ---------- раздел «Безопасность» ---------- */

  /* Соединение не должно устанавливаться: порт закрыт для этого источника. */
  C.tcpClosed = function (from, ip, port, label, opts) {
    opts = opts || {};
    return mk((label || 'Закрыто') + ': ' + from + (opts.srcIP ? ' (' + opts.srcIP + ')' : '') + ' → ' + ip + ':' + port,
      function (world) {
        var m = world.get(from);
        if (!m) return { ok: false, detail: 'нет хоста ' + from };
        var r = P.tcpConnect(world, m, ip, port, { srcIP: opts.srcIP });
        return { ok: !r.ok, detail: r.ok ? 'соединение проходит, а не должно' : null };
      });
  };

  C.serviceEnabled = function (host, unit) {
    return mk('Сервис ' + unit + ' в автозапуске на ' + host, function (world) {
      var m = world.get(host);
      var u = m && m.services.get(unit);
      if (!u) return { ok: false, detail: 'юнит не найден' };
      if (u.state !== 'active') return { ok: false, detail: 'сейчас ' + u.state };
      return { ok: !!u.enabled, detail: u.enabled ? null : 'не включён (systemctl enable)' };
    });
  };

  /* Действующий параметр sshd: учитывает Include и требует перезапуска службы. */
  C.sshdOption = function (host, key, expect) {
    return mk('sshd на ' + host + ': ' + key + ' = ' + expect, function (world) {
      var m = world.get(host);
      if (!m || !m.sshdConfig) return { ok: false, detail: 'нет хоста' };
      var cur = m.sshdConfig()[String(key).toLowerCase()];
      if (cur === undefined) return { ok: false, detail: 'параметр не задан' };
      if (String(cur).toLowerCase() !== String(expect).toLowerCase()) {
        return { ok: false, detail: 'сейчас ' + cur };
      }
      var file = m.sshdFileConfig()[String(key).toLowerCase()];
      if (String(file === undefined ? '' : file).toLowerCase() !== String(expect).toLowerCase()) {
        return { ok: false, detail: 'применено, но в файле другое значение — вернётся после перезагрузки' };
      }
      return { ok: true };
    });
  };

  C.sysctlIs = function (host, key, expect) {
    return mk('Параметр ядра ' + key + ' = ' + expect + ' на ' + host, function (world) {
      var m = world.get(host);
      var cur = m && m.net.sysctl[key];
      if (cur === undefined) return { ok: false, detail: 'параметр неизвестен' };
      return { ok: String(cur) === String(expect), detail: String(cur) === String(expect) ? null : 'сейчас ' + cur };
    });
  };

  C.ufwActive = function (host, incoming) {
    return mk('ufw на ' + host + ' включён' + (incoming ? ', политика ' + incoming : ''), function (world) {
      var m = world.get(host);
      if (!m.fw.ufw.enabled) return { ok: false, detail: 'Status: inactive' };
      if (incoming && m.fw.ufw.defaults.incoming !== incoming) {
        return { ok: false, detail: 'политика incoming: ' + m.fw.ufw.defaults.incoming };
      }
      if (!m.services.isEnabled('ufw')) return { ok: false, detail: 'юнит ufw не в автозапуске' };
      return { ok: true };
    });
  };

  C.ipBanned = function (host, ip) {
    return mk('Адрес ' + ip + ' заблокирован на ' + host, function (world) {
      var m = world.get(host);
      var blocked = m.fw.evaluate('INPUT', {
        proto: 'tcp', src: ip, dst: m.net.primaryIP(), dport: 22, ct: 'NEW', inIface: 'ens33', dry: true
      });
      return { ok: blocked !== 'ACCEPT', detail: blocked === 'ACCEPT' ? 'пакеты с него по-прежнему принимаются' : null };
    });
  };

  /* Файл отсутствует (удалённый бэкдор, лишняя задача cron, дамп в веб-корне). */
  C.fileAbsent = function (host, path, label) {
    return mk((label || 'Файла нет') + ': ' + host + ':' + path, function (world) {
      var m = world.get(host);
      var exists = m.vfs.exists(path, NET.ROOTCTX);
      return { ok: !exists, detail: exists ? 'файл всё ещё на месте' : null };
    });
  };

  /* Содержимое файла (не) содержит строку. */
  C.fileHas = function (host, path, text, opts) {
    opts = opts || {};
    var want = opts.absent ? 'не содержит' : 'содержит';
    return mk('Файл ' + path + ' на ' + host + ' ' + want + ' «' + text + '»', function (world) {
      var m = world.get(host);
      if (!m.vfs.exists(path, NET.ROOTCTX)) {
        return { ok: !!opts.absent, detail: opts.absent ? null : 'файла нет' };
      }
      var data = m.vfs.read(path, NET.ROOTCTX);
      var found = data.indexOf(text) >= 0;
      return { ok: opts.absent ? !found : found, detail: (opts.absent ? found : !found) ? 'проверьте содержимое файла' : null };
    });
  };

  /* Права файла не шире максимальных (0o640 и т. п.). */
  C.modeAtMost = function (host, path, maxMode) {
    return mk('Права ' + path + ' на ' + host + ' не шире ' + maxMode.toString(8), function (world) {
      var m = world.get(host);
      var n = m.vfs.get(path, NET.ROOTCTX);
      if (!n) return { ok: true, detail: null };
      var cur = (n.mode || 0) & 0o7777;
      var extra = cur & ~maxMode;
      return { ok: extra === 0, detail: extra ? 'сейчас ' + cur.toString(8) : null };
    });
  };

  /* HTTP-ответ сервера на путь: статус должен совпасть с ожидаемым. */
  C.httpStatus = function (from, ip, port, path, expect, label) {
    return mk((label || 'HTTP') + ' ' + path + ' → ' + expect, function (world) {
      var m = world.get(from);
      var r = NET.httpd.request(world, m, ip, port, path, { srcIP: (m.net.allAddrs(4)[0] || {}).ip });
      if (!r.ok) {
        var closed = [403, 404, 'closed'].indexOf(expect) >= 0;
        return { ok: closed, detail: closed ? null : 'соединение не установилось: ' + describe(r) };
      }
      if (expect === 'closed') return { ok: false, detail: 'сервер ответил ' + r.status + ', соединение открыто' };
      return { ok: r.status === expect, detail: r.status === expect ? null : 'ответ ' + r.status };
    });
  };

  /* Нет посторонних пользователей с uid 0 (кроме root). */
  C.noExtraRootUsers = function (host) {
    return mk('На ' + host + ' нет посторонних учётных записей с uid 0', function (world) {
      var m = world.get(host);
      var extra = m.users.users.filter(function (u) { return u.uid === 0 && u.name !== 'root'; });
      return { ok: !extra.length, detail: extra.length ? 'найдены: ' + extra.map(function (u) { return u.name; }).join(', ') : null };
    });
  };

  C.userAbsent = function (host, name) {
    return mk('Учётной записи ' + name + ' на ' + host + ' нет', function (world) {
      var m = world.get(host);
      var u = m.users.byName(name);
      if (!u) return { ok: true };
      var blocked = /nologin|false/.test(u.shell) && m.users.groupNamesOf(name).indexOf('sudo') < 0;
      return { ok: false, detail: blocked ? 'учётка осталась (вход закрыт, но её быть не должно)' : 'учётка активна' };
    });
  };

  /* Ни одного SUID-файла вне эталонного списка системы. */
  C.noExtraSuid = function (host, baseline) {
    return mk('На ' + host + ' нет посторонних SUID-файлов', function (world) {
      var m = world.get(host);
      var found = [];
      m.vfs.walkTree('/', NET.ROOTCTX, function (path, node) {
        if (node.type !== 'file') return;
        if ((node.mode & 0o4000) && baseline.indexOf(path) < 0) found.push(path);
      });
      return { ok: !found.length, detail: found.length ? 'найдены: ' + found.slice(0, 3).join(', ') : null };
    });
  };

  /* Никто не слушает порт (бэкдор снят вместе с процессом). */
  C.portClosed = function (host, port, proto) {
    return mk('На ' + host + ' никто не слушает ' + (proto || 'tcp') + '/' + port, function (world) {
      var m = world.get(host);
      var s = m.net.listening(port, proto || 'tcp');
      return { ok: !s, detail: s ? 'слушает ' + (s.process || '?') + ' на ' + s.addr : null };
    });
  };

  C.custom = function (title, fn) { return mk(title, fn); };

  function describe(r) {
    var E = NET.packet.E;
    var map = {};
    map[E.NETUNREACH] = 'нет маршрута (Network is unreachable)';
    map[E.NETDOWN] = 'интерфейс down';
    map[E.HOSTUNREACH] = 'ARP не разрешается (Destination Host Unreachable)';
    map[E.TIMEOUT] = 'нет ответа (таймаут / DROP)';
    map[E.REFUSED] = 'соединение отклонено (RST)';
    map[E.MSGSIZE] = 'пакет больше локального MTU';
    map[E.FRAGNEEDED] = 'нужна фрагментация (MTU по пути меньше)';
    map[E.BLACKHOLE] = 'MTU-blackhole: ICMP frag needed заглушен';
    map[E.PORTUNREACH] = 'порт недоступен (ICMP port unreachable)';
    map[E.UNREACH_ADMIN] = 'заблокировано административно (REJECT)';
    map[E.TTL] = 'TTL истёк';
    map[E.PERM] = 'локальный firewall (OUTPUT) запрещает';
    return map[r.error] || ('ошибка ' + r.error);
  }

  C.describe = describe;
  NET.checks = C;
})(window.NET);
