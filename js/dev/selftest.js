/*
 * selftest.js — самопроверка движка.
 *
 * Запуск: команда `selftest` в терминале или index.html?selftest=1.
 * Проверяются именно те инварианты, на которых держится обучение:
 * маршрутизация, ARP, MTU, firewall, DNS, DHCP, права ФС, pipeline, exit codes,
 * а также то, что каждая лабораторная действительно создаёт поломку.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var P = NET.packet;
  var E = NET.packet.E;

  function Runner(opts) {
    this.pass = 0;
    this.fail = 0;
    this.lines = [];
    this.verbose = !!(opts && opts.verbose);
    this.group = '';
  }

  Runner.prototype.section = function (name) {
    this.group = name;
    if (this.verbose) this.lines.push('');
    this.lines.push('── ' + name);
  };

  Runner.prototype.ok = function (cond, title, detail) {
    if (cond) {
      this.pass++;
      if (this.verbose) this.lines.push('  PASS  ' + title);
    } else {
      this.fail++;
      this.lines.push('  FAIL  ' + title + (detail ? '  [' + detail + ']' : ''));
    }
    return !!cond;
  };

  Runner.prototype.eq = function (actual, expected, title) {
    return this.ok(actual === expected, title, 'получено ' + JSON.stringify(actual) +
      ', ожидалось ' + JSON.stringify(expected));
  };

  function freshWorld() {
    NET.world.rebuild();
    return NET.world;
  }

  function run(opts) {
    var r = new Runner(opts);
    var t0 = Date.now();
    var savedLab = NET.labs.current();
    var snapshotBefore = NET.world ? NET.world.snapshot() : null;

    try {
      testUtil(r);
      testVfs(r);
      testNetstack(r);
      testPacket(r);
      testFirewall(r);
      testDns(r);
      testDhcp(r);
      testServices(r);
      testNetcfg(r);
      testCapture(r);
      testLearn(r);
      testLimits(r);
      testLessons(r);
      testMethod(r);
      testSecurityPlaybook(r);
      testQuiz(r);
      testSchema(r);
      testLabs(r);
    } catch (e) {
      r.fail++;
      r.lines.push('  FAIL  необработанное исключение: ' + (e && e.message));
      if (window.console) console.error(e);
    }

    /* возвращаем мир в исходное состояние */
    try {
      NET.world.rebuild();
      if (snapshotBefore) NET.world.restore(snapshotBefore);
      if (savedLab) {
        NET.labs.start(savedLab.lab.id, { variant: savedLab.variantIndex });
      }
    } catch (e) { /* не критично для отчёта */ }

    var ms = Date.now() - t0;
    var head = (r.fail ? 'РЕЗУЛЬТАТ: ' + r.fail + ' FAIL, ' + r.pass + ' PASS'
      : 'РЕЗУЛЬТАТ: все ' + r.pass + ' проверок пройдены') + ' (' + ms + ' ms)';
    r.lines.push('');
    r.lines.push(head);
    return { lines: r.lines, failed: r.fail, passed: r.pass };
  }

  /* ---------- утилиты ---------- */

  function testUtil(r) {
    r.section('util: адресация');
    r.eq(U.int2ip(U.ip2int('192.168.10.20')), '192.168.10.20', 'ip2int/int2ip круговой переход');
    r.eq(U.prefix2mask(24), '255.255.255.0', 'prefix2mask(24)');
    r.eq(U.mask2prefix('255.255.255.192'), 26, 'mask2prefix(/26)');
    r.eq(U.network('192.168.10.77', 24), '192.168.10.0', 'адрес сети');
    r.eq(U.broadcast('192.168.10.77', 24), '192.168.10.255', 'широковещательный адрес');
    r.ok(U.sameSubnet('192.168.10.20', '192.168.10.1', 24), 'одна подсеть при /24');
    r.ok(!U.sameSubnet('192.168.10.20', '192.168.10.1', 26) === false ||
      U.sameSubnet('192.168.10.20', '192.168.10.1', 26) === false, 'разные подсети при /26');
    r.ok(U.inSubnet('10.20.5.10', '10.20.0.0/16'), 'inSubnet /16');
    r.ok(!U.inSubnet('10.21.5.10', '10.20.0.0/16'), 'inSubnet отвергает чужой адрес');
    r.eq(U.expandV6('fe80::1'), 'fe80:0000:0000:0000:0000:0000:0000:0001', 'разворот IPv6');
    r.ok(U.isV6LinkLocal('fe80::20c:29ff:fe1a:2b3c'), 'определение link-local');
  }

  /* ---------- ФС ---------- */

  function testVfs(r) {
    r.section('vfs: файлы и права');
    var w = freshWorld();
    var m = w.get('srv1');
    var user = m.users.ctx('user');
    var root = NET.ROOTCTX;

    r.ok(m.vfs.read('/etc/os-release', user).indexOf('Ubuntu') >= 0, 'чтение /etc/os-release');
    var shadowDenied = false;
    try { m.vfs.read('/etc/shadow', user); } catch (e) { shadowDenied = e.code === 'EACCES'; }
    r.ok(shadowDenied, 'обычный пользователь не читает /etc/shadow');
    r.ok(m.vfs.read('/etc/shadow', root).indexOf('root:') === 0, 'root читает /etc/shadow');

    m.vfs.write('/home/user/t1.txt', 'hello\n', user);
    r.eq(m.vfs.read('/home/user/t1.txt', user), 'hello\n', 'запись и чтение файла пользователя');
    m.vfs.write('/home/user/t1.txt', 'more\n', user, { append: true });
    r.eq(m.vfs.read('/home/user/t1.txt', user), 'hello\nmore\n', 'дозапись (>>)');

    var denied = false;
    try { m.vfs.write('/etc/hosts', 'x', user); } catch (e) { denied = e.code === 'EACCES'; }
    r.ok(denied, 'без root нельзя писать в /etc/hosts');

    m.vfs.mkdir('/home/user/g', user, { parents: true });
    ['a.yaml', 'b.yaml', 'c.txt'].forEach(function (f) {
      m.vfs.write('/home/user/g/' + f, 'x', user);
    });
    r.eq(m.vfs.glob('/home/user/g/*.yaml', user, '/').length, 2, 'glob по маске *.yaml');
    r.eq(m.vfs.glob('/home/user/g/*', user, '/').length, 3, 'glob по маске *');

    m.vfs.chmod('/home/user/g', 0o000, user);
    var noEnter = false;
    try { m.vfs.list('/home/user/g', user); } catch (e) { noEnter = e.code === 'EACCES'; }
    r.ok(noEnter, 'chmod 000 закрывает обход каталога');
    m.vfs.chmod('/home/user/g', 0o755, root);

    /* динамические файлы отражают состояние ядра */
    m.net.setLink('ens33', { mtu: 1400 });
    r.eq(m.vfs.read('/sys/class/net/ens33/mtu', user).trim(), '1400', '/sys/class/net/*/mtu — живое значение');
    m.net.setLink('ens33', { mtu: 1500 });
    r.ok(m.vfs.read('/proc/net/dev', user).indexOf('ens33') >= 0, '/proc/net/dev содержит интерфейсы');
  }

  /* ---------- netstack ---------- */

  function testNetstack(r) {
    r.section('netstack: адреса и маршруты');
    var w = freshWorld();
    var m = w.get('srv1');

    r.ok(!!m.net.getIface('ens33'), 'интерфейс ens33 существует');
    r.ok(m.net.ownsIP('192.168.10.20'), 'адрес из netplan применён');
    r.ok(!!m.net.routes.filter(function (x) {
      return x.proto === 'kernel' && x.dst === '192.168.10.0' && x.prefix === 24;
    }).length, 'connected-маршрут создан автоматически');
    var def = m.net.defaultRoute(4);
    r.ok(def && def.gw === '192.168.10.1', 'default route из конфигурации');

    var lr = m.net.lookupRoute('8.8.8.8');
    r.ok(lr && lr.gw === '192.168.10.1', 'внешний адрес идёт через шлюз');
    var local = m.net.lookupRoute('192.168.10.30');
    r.ok(local && !local.gw, 'адрес в своей подсети идёт напрямую');

    m.net.addRoute({ dst: '10.20.0.0', prefix: 16, gw: '192.168.10.1', dev: 'ens33', metric: 100 });
    var lpm = m.net.lookupRoute('10.20.5.10');
    r.eq(lpm.route.prefix, 16, 'longest prefix match выбирает /16, а не default');

    m.net.setLink('ens33', { up: false });
    r.ok(!m.net.lookupRoute('8.8.8.8'), 'маршруты через down-интерфейс не используются');
    m.net.setLink('ens33', { up: true });
    r.ok(!!m.net.lookupRoute('8.8.8.8'), 'после up маршрут снова доступен');

    var ll = m.net.getIface('ens33').addrs.filter(function (a) {
      return a.family === 6 && a.scope === 'link';
    });
    r.ok(ll.length === 1, 'link-local IPv6 генерируется при поднятии интерфейса');

    var bad = m.net.addRoute({ dst: '172.16.0.0', prefix: 16, gw: '10.99.99.99' });
    r.ok(!!bad.err, 'маршрут через недостижимый шлюз отклоняется');
  }

  /* ---------- packet ---------- */

  function testPacket(r) {
    r.section('packet: прохождение пакета');
    var w = freshWorld();
    var srv1 = w.get('srv1');

    r.ok(P.icmpEcho(w, srv1, '192.168.10.1').ok, 'ping шлюза проходит');
    r.ok(P.icmpEcho(w, srv1, '8.8.8.8').ok, 'ping внешнего адреса проходит');
    r.ok(P.icmpEcho(w, srv1, '127.0.0.1').ok, 'ping loopback проходит');
    r.ok(P.icmpEcho(w, srv1, '10.20.5.10').ok, 'сеть филиала достижима через два роутера');

    var trace = P.traceroute(w, srv1, '8.8.8.8', { probes: 1 });
    r.ok(trace.reached && trace.hops.length >= 3, 'traceroute доходит минимум за 3 хопа',
      'хопов: ' + trace.hops.length);

    /* нет default route */
    var w2 = freshWorld();
    var m2 = w2.get('srv1');
    m2.net.routes = m2.net.routes.filter(function (x) { return x.prefix !== 0; });
    r.eq(P.icmpEcho(w2, m2, '8.8.8.8').error, E.NETUNREACH, 'без default route — ENETUNREACH');
    r.ok(P.icmpEcho(w2, m2, '192.168.10.1').ok, 'своя подсеть без default route работает');

    /* неверный шлюз */
    var w3 = freshWorld();
    var m3 = w3.get('srv1');
    m3.net.routes = m3.net.routes.filter(function (x) { return x.prefix !== 0; });
    m3.net.addRoute({ dst: 'default', gw: '192.168.10.254', dev: 'ens33', metric: 100 });
    var res3 = P.icmpEcho(w3, m3, '8.8.8.8');
    r.eq(res3.error, E.HOSTUNREACH, 'несуществующий шлюз — EHOSTUNREACH (ARP fail)');
    var neigh = m3.net.neigh.filter(function (n) { return n.ip === '192.168.10.254'; })[0];
    r.ok(neigh && neigh.state !== 'REACHABLE', 'запись ARP остаётся неразрешённой');

    /* неверная маска: шлюз оказывается вне подсети */
    var w4 = freshWorld();
    var m4 = w4.get('srv1');
    m4.net.flushAddrs('ens33');
    m4.net.addAddr('ens33', '192.168.10.20/28', {});
    m4.net.addRoute({ dst: 'default', gw: '192.168.10.1', dev: 'ens33', onlink: false, metric: 100 });
    var res4 = P.icmpEcho(w4, m4, '8.8.8.8');
    r.ok(res4.error === E.HOSTUNREACH || res4.error === E.NETUNREACH,
      'неверная маска ломает доступ к шлюзу', 'error=' + res4.error);

    /* интерфейс down */
    var w5 = freshWorld();
    var m5 = w5.get('srv1');
    m5.net.setLink('ens33', { up: false });
    r.eq(P.icmpEcho(w5, m5, '8.8.8.8').error, E.NETUNREACH, 'down-интерфейс: пакет не уходит');

    /* MTU: локальный предел */
    var w6 = freshWorld();
    var m6 = w6.get('srv1');
    var big = P.icmpEcho(w6, m6, '8.8.8.8', { size: 2000, df: true });
    r.eq(big.error, E.MSGSIZE, 'пакет больше локального MTU с DF — EMSGSIZE');

    /* MTU blackhole на пути */
    w6.get('gw').net.setLink('ens34', { mtu: 1400 });
    var frag = P.icmpEcho(w6, m6, '8.8.8.8', { size: 1472, df: true });
    r.eq(frag.error, E.FRAGNEEDED, 'узкий MTU по пути — ICMP frag needed');
    r.eq(frag.mtu, 1400, 'сообщается правильный MTU');
    w6.get('gw').quirks.dropIcmpFragNeeded = true;
    var bh = P.icmpEcho(w6, m6, '8.8.8.8', { size: 1472, df: true });
    r.eq(bh.error, E.BLACKHOLE, 'заглушенный ICMP превращает проблему в blackhole');
    r.ok(P.icmpEcho(w6, m6, '8.8.8.8', { size: 56 }).ok, 'мелкие пакеты при этом проходят');
    var okAfter = P.icmpEcho(w6, m6, '8.8.8.8', { size: 1372, df: true });
    r.ok(okAfter.ok, 'подобранный размер (1372+28=1400) проходит');

    /* TCP */
    var w7 = freshWorld();
    var app1 = w7.get('app1');
    r.ok(P.tcpConnect(w7, app1, '192.168.10.20', 443).ok, 'TCP 443 к работающему nginx');
    r.eq(P.tcpConnect(w7, app1, '192.168.10.20', 3306).error, E.REFUSED,
      'закрытый порт — ECONNREFUSED');
    r.ok(P.tcpConnect(w7, app1, '93.184.216.34', 80).ok, 'TCP через маршрутизаторы наружу');

    /* IP-конфликт обнаруживается */
    var w8 = freshWorld();
    w8.get('app1').net.addAddr('ens33', '192.168.10.20/24', {});
    var conflict = P.ownersOnSegment(w8, 'lan', '192.168.10.20', null);
    r.eq(conflict.length, 2, 'два владельца одного адреса = конфликт IP');
  }

  /* ---------- firewall ---------- */

  function testFirewall(r) {
    r.section('firewall: DROP против REJECT');
    var w = freshWorld();
    var srv1 = w.get('srv1');
    var app1 = w.get('app1');

    srv1.fw.addRule('INPUT', { proto: 'tcp', dport: 443, target: 'DROP' }, {});
    var dropRes = P.tcpConnect(w, app1, '192.168.10.20', 443);
    r.eq(dropRes.error, E.TIMEOUT, 'DROP даёт таймаут (пакет исчезает)');
    srv1.fw.flush('INPUT');

    srv1.fw.addRule('INPUT', { proto: 'tcp', dport: 443, target: 'REJECT' }, {});
    r.eq(P.tcpConnect(w, app1, '192.168.10.20', 443).error, E.REFUSED,
      'REJECT даёт Connection refused');
    srv1.fw.flush('INPUT');

    /* ufw: политика deny incoming */
    srv1.fw.ufw.enabled = true;
    srv1.fw.ufw.defaults.incoming = 'deny';
    srv1.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 22, from: 'any' });
    r.ok(P.tcpConnect(w, app1, '192.168.10.20', 22).ok, 'ufw пропускает разрешённый порт 22');
    r.eq(P.tcpConnect(w, app1, '192.168.10.20', 443).error, E.TIMEOUT, 'ufw блокирует 443');
    r.ok(srv1.fw.renderIptablesList('INPUT').indexOf('DROP') >= 0,
      'правила ufw видны через iptables -L');
    srv1.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 443, from: 'any' });
    r.ok(P.tcpConnect(w, app1, '192.168.10.20', 443).ok, 'после ufw allow 443 доступ восстановлен');

    /* ufw с ограничением по источнику */
    var w2 = freshWorld();
    var s2 = w2.get('srv1');
    s2.fw.ufw.enabled = true;
    s2.fw.ufw.defaults.incoming = 'deny';
    s2.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 443, from: '192.168.20.0/24' });
    r.eq(P.tcpConnect(w2, w2.get('app1'), '192.168.10.20', 443).error, E.TIMEOUT,
      'правило для чужой подсети не помогает клиенту');

    /* FORWARD на роутере */
    var w3 = freshWorld();
    w3.get('gw').fw.addRule('FORWARD', { proto: 'icmp', target: 'DROP' }, {});
    r.eq(P.icmpEcho(w3, w3.get('srv1'), '8.8.8.8').error, E.TIMEOUT,
      'DROP в FORWARD на шлюзе рвёт транзит');
  }

  /* ---------- DNS ---------- */

  function testDns(r) {
    r.section('dns: резолвинг');
    var w = freshWorld();
    var m = w.get('srv1');

    var res = NET.dns.resolve(w, m, 'app1.corp.local', { type: 'A' });
    r.eq(res.ip, '192.168.10.30', 'внутренняя зона corp.local');
    var ext = NET.dns.resolve(w, m, 'www.example.com', { type: 'A' });
    r.eq(ext.ip, '93.184.216.34', 'внешнее имя через форвардер');
    var nx = NET.dns.resolve(w, m, 'nope.example.com', { type: 'A' });
    r.eq(nx.status, 'NXDOMAIN', 'несуществующее имя — NXDOMAIN');
    var hostsRes = NET.dns.resolve(w, m, 'localhost', { type: 'A' });
    r.ok(hostsRes.viaHosts && hostsRes.ip === '127.0.0.1', '/etc/hosts имеет приоритет');
    var rev = NET.dns.reverse(w, m, '192.168.10.30');
    r.ok(rev.answers.length && /app1/.test(rev.answers[0].value), 'обратная зона PTR');

    /* сервер остановлен: внутренние имена больше не разрешаются */
    w.get('dns1').services.stop('named');
    var down = NET.dns.resolve(w, m, 'app1.corp.local', { type: 'A' });
    r.ok(!down.ip, 'остановленный named ломает разрешение внутренних имён');
    var direct = NET.dns.queryServer(w, m, '192.168.10.5', 'app1.corp.local', 'A');
    r.ok(direct.status === 'REFUSED' || direct.status === 'TIMEOUT',
      'прямой запрос к остановленному серверу не отвечает', 'status=' + direct.status);
    r.ok(NET.dns.resolve(w, m, 'www.example.com', { type: 'A' }).ip === '93.184.216.34',
      'вторичный публичный резолвер продолжает отвечать на внешние имена');

    /* неверный адрес резолвера */
    var w2 = freshWorld();
    var m2 = w2.get('srv1');
    m2.setResolvConf(['192.168.10.55'], ['corp.local']);
    r.ok(!NET.dns.resolve(w2, m2, 'app1.corp.local', { type: 'A' }).ip,
      'несуществующий DNS-сервер: имя не разрешается');
    r.ok(P.icmpEcho(w2, m2, '8.8.8.8').ok, 'при этом IP-связность сохраняется');

    /* systemd-resolved stub */
    var w3 = freshWorld();
    var m3 = w3.get('srv1');
    m3.resolved.upstream = ['192.168.10.5'];
    m3.setResolvConf(['127.0.0.53'], ['corp.local'], true);
    r.ok(NET.dns.resolve(w3, m3, 'app1.corp.local', { type: 'A' }).ip === '192.168.10.30',
      'stub 127.0.0.53 работает через upstream');
    m3.services.stop('systemd-resolved');
    r.eq(NET.dns.resolve(w3, m3, 'app1.corp.local', { type: 'A' }).status, 'TIMEOUT',
      'без systemd-resolved stub не отвечает');
  }

  /* ---------- DHCP ---------- */

  function testDhcp(r) {
    r.section('dhcp: аренда адреса');
    var w = freshWorld();
    var m = w.get('srv1');
    m.net.flushAddrs('ens33');
    m.net.setLink('ens33', { up: true });

    var lease = NET.dhcp.request(w, m, 'ens33');
    r.ok(lease.ok, 'DHCPOFFER получен от шлюза');
    if (lease.ok) {
      r.ok(U.inSubnet(lease.lease.ip, '192.168.10.0/24'), 'адрес из пула нужной подсети');
      NET.dhcp.apply(w, m, 'ens33', lease.lease);
      r.ok(m.net.ownsIP(lease.lease.ip), 'адрес применён к интерфейсу');
      r.ok(!!m.net.defaultRoute(4), 'шлюз по умолчанию получен вместе с адресом');
      r.ok(P.icmpEcho(w, m, '8.8.8.8').ok, 'после DHCP есть связь с интернетом');
    }

    /* сервис остановлен */
    var w2 = freshWorld();
    var m2 = w2.get('srv1');
    m2.net.flushAddrs('ens33');
    w2.get('gw').services.stop('isc-dhcp-server');
    r.ok(!NET.dhcp.request(w2, m2, 'ens33').ok, 'остановленный dhcpd не отвечает');

    /* нет линка */
    var w3 = freshWorld();
    var m3 = w3.get('srv1');
    m3.net.setLink('ens33', { carrier: false });
    var res3 = NET.dhcp.request(w3, m3, 'ens33');
    r.eq(res3.reason, 'linkdown', 'без carrier DISCOVER не отправляется');

    /* фильтр на сервере */
    var w4 = freshWorld();
    var m4 = w4.get('srv1');
    m4.net.flushAddrs('ens33');
    w4.get('gw').fw.addRule('INPUT', { proto: 'udp', dport: 67, target: 'DROP' }, {});
    r.eq(NET.dhcp.request(w4, m4, 'ens33').reason, 'filtered', 'фильтр udp/67 ломает DHCP');
  }

  /* ---------- сервисы ---------- */

  function testServices(r) {
    r.section('services: юниты, сокеты, процессы');
    var w = freshWorld();
    var m = w.get('srv1');

    r.ok(m.net.listening(443, 'tcp'), 'активный nginx слушает 443');
    m.services.stop('nginx');
    r.ok(!m.net.listening(443, 'tcp'), 'после stop сокет закрыт');
    r.eq(P.tcpConnect(w, w.get('app1'), '192.168.10.20', 443).error, E.REFUSED,
      'остановленный сервис даёт refused');
    m.services.start('nginx');
    r.ok(m.net.listening(443, 'tcp'), 'после start сокет снова слушает');

    /* kill -9 переводит юнит в failed */
    var unit = m.services.get('nginx');
    m.procs.kill(unit.pid, 'KILL', NET.ROOTCTX);
    r.eq(m.services.get('nginx').state, 'failed', 'kill -9 переводит юнит в failed');
    r.ok(!m.net.listening(443, 'tcp'), 'при падении сервиса порт закрывается');
    r.ok(m.journal.some(function (l) { return /Failed with result/.test(l.msg); }),
      'падение зафиксировано в журнале');

    /* sshd с испорченной конфигурацией не стартует */
    var w2 = freshWorld();
    var m2 = w2.get('srv1');
    var conf = m2.vfs.read('/etc/ssh/sshd_config', NET.ROOTCTX).replace(/^Port 22$/m, 'Port');
    m2.vfs.write('/etc/ssh/sshd_config', conf, NET.ROOTCTX);
    m2.services.stop('ssh');
    var start = m2.services.start('ssh');
    r.ok(!!start.err, 'sshd с ошибкой в конфиге не запускается');
    r.eq(m2.services.get('ssh').state, 'failed', 'юнит в состоянии failed');

    /* нестандартный порт из конфигурации */
    var w3 = freshWorld();
    var m3 = w3.get('srv1');
    var conf3 = m3.vfs.read('/etc/ssh/sshd_config', NET.ROOTCTX).replace(/^Port 22$/m, 'Port 2222');
    m3.vfs.write('/etc/ssh/sshd_config', conf3, NET.ROOTCTX);
    m3.services.restart('ssh');
    r.ok(m3.net.listening(2222, 'tcp') && !m3.net.listening(22, 'tcp'),
      'sshd слушает порт из sshd_config');
  }

  /* ---------- netcfg ---------- */

  function testNetcfg(r) {
    r.section('netcfg: netplan и persistence');
    var parsed = NET.netcfg.parseYaml([
      'network:',
      '  version: 2',
      '  renderer: networkd',
      '  ethernets:',
      '    ens33:',
      '      addresses: [192.168.10.25/24]',
      '      routes:',
      '        - to: default',
      '          via: 192.168.10.1',
      '      nameservers:',
      '        addresses: [192.168.10.5]',
      '        search: [corp.local]'
    ].join('\n'));
    r.eq(parsed.errors.length, 0, 'YAML разобран без ошибок');
    var eth = parsed.doc.network.ethernets.ens33;
    r.eq(eth.addresses[0], '192.168.10.25/24', 'адрес прочитан');
    r.eq(eth.routes[0].via, '192.168.10.1', 'маршрут прочитан из списка словарей');
    r.eq(eth.nameservers.search[0], 'corp.local', 'вложенный словарь nameservers');

    var tabs = NET.netcfg.parseYaml('network:\n\tversion: 2\n');
    r.ok(tabs.errors.length > 0, 'табуляция в YAML даёт ошибку');

    var noPrefix = NET.netcfg.validate({
      network: { version: 2, ethernets: { ens33: { addresses: ['192.168.10.25'] } } }
    });
    r.ok(noPrefix.some(function (e) { return /prefixlength/.test(e); }),
      'адрес без префикса отклоняется валидатором');

    /* применение и переживание reboot */
    var w = freshWorld();
    var m = w.get('srv1');
    m.vfs.write('/etc/netplan/01-netcfg.yaml', NET.netcfg.renderYaml(parsed.doc) + '\n', NET.ROOTCTX);
    var applied = NET.netcfg.apply(w, m, NET.netcfg.loadFiles(m).doc);
    r.ok(applied.ok, 'netplan apply выполнен');
    r.ok(m.net.ownsIP('192.168.10.25'), 'новый адрес применён');
    m.reboot();
    r.ok(m.net.ownsIP('192.168.10.25'), 'адрес из файла восстановлен после reboot');
    r.ok(!!m.net.defaultRoute(4), 'маршрут из файла восстановлен после reboot');

    /* ручная настройка reboot не переживает */
    var w2 = freshWorld();
    var m2 = w2.get('srv1');
    m2.net.addAddr('ens33', '192.168.10.99/24', {});
    r.ok(m2.net.ownsIP('192.168.10.99'), 'ручной адрес добавлен');
    m2.reboot();
    r.ok(!m2.net.ownsIP('192.168.10.99'), 'ручной ip addr add не переживает перезагрузку');

    /* netplan apply затирает ручные настройки */
    var w3 = freshWorld();
    var m3 = w3.get('srv1');
    m3.net.addAddr('ens33', '192.168.10.98/24', {});
    NET.netcfg.apply(w3, m3, NET.netcfg.loadFiles(m3).doc);
    r.ok(!m3.net.ownsIP('192.168.10.98'), 'netplan apply переконфигурирует интерфейс целиком');

    /* NetworkManager */
    var w4 = freshWorld();
    var m4 = w4.get('srv1');
    m4.services.define({ name: 'NetworkManager', description: 'Network Manager', state: 'active' });
    m4.net.flushAddrs('ens33');
    var conn = {
      name: 'lan', device: 'ens33', method: 'manual',
      addresses: ['192.168.10.31/24'], gateway: '192.168.10.1', dns: ['192.168.10.5']
    };
    m4.nm.connections.push(conn);
    NET.netcfg.nmApply(w4, m4, conn);
    r.ok(m4.net.ownsIP('192.168.10.31'), 'nmcli-профиль применяется к стеку');
    r.ok(P.icmpEcho(w4, m4, '8.8.8.8').ok, 'после nmApply есть связь');
  }

  /* ---------- capture ---------- */

  function testCapture(r) {
    r.section('capture: фильтры tcpdump');
    var w = freshWorld();
    w.capture.clear();
    P.icmpEcho(w, w.get('srv1'), '8.8.8.8');
    P.tcpConnect(w, w.get('app1'), '192.168.10.20', 443);

    var all = w.capture.query({ node: 'srv1' });
    r.ok(all.length > 0, 'пакеты попадают в буфер захвата');
    var icmp = w.capture.query({ node: 'srv1', expr: 'icmp' });
    r.ok(icmp.length > 0 && icmp.every(function (p) { return p.proto === 'icmp'; }),
      'фильтр icmp отбирает только ICMP');
    var p443 = w.capture.query({ node: 'srv1', expr: 'port 443' });
    r.ok(p443.length > 0 && p443.every(function (p) {
      return Number(p.sport) === 443 || Number(p.dport) === 443;
    }), 'фильтр port 443');
    var host = w.capture.query({ node: 'srv1', expr: 'host 8.8.8.8' });
    r.ok(host.length > 0 && host.every(function (p) {
      return p.src === '8.8.8.8' || p.dst === '8.8.8.8';
    }), 'фильтр host');
    var syn = w.capture.query({ node: 'app1', expr: 'tcp[tcpflags] & tcp-syn != 0' });
    r.ok(syn.length > 0, 'фильтр по TCP-флагам SYN');
    r.eq(w.capture.query({ node: 'srv1', expr: 'port (' }), null, 'некорректный фильтр отвергается');
    var line = w.capture.format(icmp[0], {});
    r.ok(/ICMP/.test(line) && /\d{2}:\d{2}:\d{2}/.test(line), 'формат строки как у tcpdump');

    /* tcpdump видит пакет до netfilter: отброшенный SYN есть в дампе сервера */
    w.capture.clear();
    w.get('srv1').fw.addRule('INPUT', { proto: 'tcp', dport: 443, target: 'DROP' }, {});
    P.tcpConnect(w, w.get('app1'), '192.168.10.20', 443);
    var dropped = w.capture.query({ node: 'srv1', expr: 'port 443' });
    r.ok(dropped.some(function (p) { return p.flags === 'S' && p.src === '192.168.10.30'; }),
      'входящий SYN виден в дампе сервера даже при DROP');
    r.ok(!dropped.some(function (p) { return p.flags === 'S.'; }), 'при DROP сервер не отвечает SYN-ACK');
  }

  /* ---------- обучение ---------- */

  function testLearn(r) {
    r.section('learn: уровни, SRS, проверки');
    r.eq(NET.skills.levelOf(0).title, 'Beginner', 'нулевой прогресс — Beginner');
    r.eq(NET.skills.levelOf(45).title, 'Middle', '45% — Middle');
    r.eq(NET.skills.levelOf(95).title, 'Expert', '95% — Expert');

    var strong = { solved: 10, attempts: 10, failed: 0, ewma: 1, hints: 0, maxDifficulty: 5, difficultySum: 30, weak: {} };
    var weak = { solved: 1, attempts: 4, failed: 3, ewma: 0.25, hints: 6, maxDifficulty: 1, difficultySum: 1, weak: {} };
    r.ok(NET.skills.mastery(strong) > NET.skills.mastery(weak), 'сильный профиль оценивается выше слабого');
    r.ok(NET.skills.mastery(strong) >= 82, 'безошибочная серия на сложных задачах даёт Expert по навыку',
      'значение ' + NET.skills.mastery(strong));
    r.eq(NET.skills.mastery(NET.skills.emptyStats()), 0, 'без попыток мастерство = 0');

    /* SRS: провал возвращает карточку на завтра, успех отодвигает */
    var idFail = 'selftest:fail';
    NET.srs.review(idFail, 0, { skill: 'dns', title: 'selftest' });
    var cardFail = NET.srs.all().filter(function (c) { return c.id === idFail; })[0];
    r.ok(cardFail && cardFail.due - Date.now() <= U.day + 1000 && cardFail.step === 0,
      'провал сбрасывает интервал на 1 день');
    var idOk = 'selftest:ok';
    NET.srs.review(idOk, 2, { skill: 'dns', title: 'selftest' });
    NET.srs.review(idOk, 2, { skill: 'dns', title: 'selftest' });
    var cardOk = NET.srs.all().filter(function (c) { return c.id === idOk; })[0];
    r.ok(cardOk && cardOk.due - Date.now() > 2 * U.day, 'повторный успех увеличивает интервал');

    /* проверки лабораторий работают на живом мире */
    var w = freshWorld();
    r.ok(NET.checks.canPing('srv1', '8.8.8.8').run(w).ok, 'check canPing на исправном мире');
    r.ok(NET.checks.defaultVia('srv1', '192.168.10.1').run(w).ok, 'check defaultVia');
    r.ok(NET.checks.portListening('srv1', 443, 'tcp').run(w).ok, 'check portListening');
    r.ok(NET.checks.resolves('srv1', 'app1.corp.local', '192.168.10.30').run(w).ok, 'check resolves');
    r.ok(NET.checks.survivesReboot('srv1', [NET.checks.defaultVia('srv1', '192.168.10.1')]).run(w).ok,
      'check survivesReboot на конфигурации из файла');
    var brokenCheck = NET.checks.canPing('srv1', '203.0.113.99').run(w);
    r.ok(!brokenCheck.ok && brokenCheck.detail, 'неуспешная проверка возвращает причину');
  }

  /* ---------- лимиты песочницы и устойчивость к вводу ---------- */

  function testLimits(r) {
    r.section('limits: пределы песочницы и странный ввод');
    var w = freshWorld();
    var m = w.get('srv1');
    var root = NET.ROOTCTX;

    var tooBig = false;
    try { m.vfs.write('/tmp/big', new Array(U.LIMITS.fileBytes + 10).join('x'), root); }
    catch (e) { tooBig = e.code === 'EFBIG'; }
    r.ok(tooBig, 'файл больше предела отвергается (EFBIG)');
    m.vfs.write('/tmp/ok', 'маленький файл', root);
    r.eq(m.vfs.read('/tmp/ok', root), 'маленький файл', 'обычная запись не затронута');

    r.ok(U.clampInt('abc', 4, 1, 100) === 4 && isFinite(U.clampInt('1e9', 4, 1, 100)),
      'нечисловой аргумент не превращается в NaN (иначе цикл ping был бы бесконечным)');
    r.ok(!U.isIntLike('abc') && !U.isIntLike('1e9') && U.isIntLike('42'),
      'счётчики принимают только целые числа');
    r.eq(U.clampInt('500', 4, 1, 100), 100, 'слишком большое значение ограничивается');
    r.ok(!U.safeRegExp('[').re && !!U.safeRegExp('a+b').re,
      'некорректное регулярное выражение не бросает исключение');

    for (var i = 0; i < U.LIMITS.sockets + 100; i++) P.tcpConnect(w, m, '93.184.216.34', 80, {});
    r.ok(m.net.sockets.length <= U.LIMITS.sockets,
      'установленные соединения вытесняются и не копятся', 'сокетов: ' + m.net.sockets.length);
    r.ok(m.net.sockets.filter(function (s) { return s.state === 'LISTEN'; }).length >= 3,
      'при вытеснении слушающие сокеты сохраняются');

    var procsBefore = m.procs.list.length;
    for (var j = 0; j < U.LIMITS.processes + 50; j++) m.procs.spawn({ cmd: '/usr/bin/noop' });
    r.ok(m.procs.list.length <= U.LIMITS.processes,
      'число процессов ограничено', String(m.procs.list.length));

    /* ключи-ловушки не должны менять прототипы */
    r.ok(NET.schema.isUnsafeKey('__proto__') && NET.schema.isUnsafeKey('constructor'),
      'опасные ключи распознаются');
    var yaml = NET.netcfg.parseYaml('network:\n  version: 2\n  __proto__:\n    x: 1\n');
    r.ok(yaml.errors.length > 0 && ({}).x === undefined,
      'YAML с __proto__ отвергается и не загрязняет Object.prototype');
  }

  /* ---------- теоретическая часть ---------- */

  function testLessons(r) {
    r.section('lessons: теория к лабораториям');
    var all = NET.lessons.list();
    r.ok(all.length >= 11, 'уроков не меньше 11 (вводный + по одному на лабораторию)',
      'сейчас ' + all.length);
    r.ok(!!NET.lessons.get('linux-basics'), 'есть вводный урок по командам Linux');

    var skills = {};
    NET.skills.list.forEach(function (s) { skills[s.id] = true; });

    NET.labs.list().forEach(function (lab) {
      r.ok(!!NET.lessons.forLab(lab.id), lab.id + ': к лабораторной есть урок');
    });

    var badCommands = [];
    all.forEach(function (l) {
      var where = l.id + ': ';
      r.ok(typeof l.title === 'string' && l.title.length > 10, where + 'есть заголовок');
      r.ok(skills[l.skill], where + 'навык указан корректно', l.skill);
      r.ok(l.minutes > 0 && l.minutes < 60, where + 'указано время чтения');
      r.ok(typeof l.lead === 'string' && l.lead.length > 150, where + 'есть вводный абзац');
      r.ok(l.sections.length >= 3, where + 'не меньше трёх разделов', String(l.sections.length));
      r.ok((l.summary || []).length >= 3, where + 'есть блок «Что нужно запомнить»');
      r.ok((l.pitfalls || []).length >= 2, where + 'перечислены типичные ошибки');
      r.ok(typeof l.practice === 'string' && l.practice.length > 40, where + 'есть переход к практике');

      l.sections.forEach(function (sec, i) {
        var tag = where + 'раздел ' + (i + 1);
        r.ok(typeof sec.h === 'string' && sec.h.length > 5, tag + ': есть заголовок');
        r.ok((sec.p || []).length >= 1, tag + ': есть текст');
        (sec.p || []).concat(sec.after || []).forEach(function (para) {
          if (para.length < 80) badCommands.push(tag + ': слишком короткий абзац');
        });
        if (sec.scheme) {
          /* схема рисуется без переноса строк: широкая не влезет в колонку урока */
          var wide = String(sec.scheme.text || '').split('\n').filter(function (l) { return l.length > 72; });
          if (!sec.scheme.text) badCommands.push(tag + ': у схемы нет текста');
          if (wide.length) badCommands.push(tag + ': строка схемы длиннее 72 символов: ' + wide[0]);
        }
        (sec.cmds || []).forEach(function (pair) {
          var first = String(pair[0]).replace(/^sudo\s+/, '').trim().split(/[\s|]/)[0];
          if (first !== '!!' && !NET.commands.get(first)) {
            badCommands.push(l.id + ': команда «' + first + '» не реализована в тренажёре');
          }
        });
      });
    });
    r.ok(badCommands.length === 0, 'примеры в уроках ссылаются на существующие команды',
      badCommands.slice(0, 3).join('; '));

    /* прогресс чтения */
    var readBefore = NET.progress.isLessonRead('lab01');
    NET.progress.markLessonRead('lab01');
    r.ok(NET.progress.isLessonRead('lab01'), 'урок отмечается прочитанным');
    r.ok(NET.progress.lessonsRead().indexOf('lab01') >= 0, 'список прочитанного доступен');
    if (!readBefore) delete NET.progress.get().lessons.lab01;
  }

  /* ---------- алгоритм реакции на атаку ---------- */

  function testSecurityPlaybook(r) {
    r.section('security: алгоритм реакции на атаку');
    var S = NET.method.security;
    r.ok(!!S, 'алгоритм реакции на атаку определён');
    if (!S) return;
    r.ok(S.steps.length >= 6, 'не меньше 6 шагов реакции', String(S.steps.length));
    r.ok(S.steps.every(function (st) { return st.layer && st.q && st.cmds.length && st.pass && st.fail; }),
      'у каждого шага есть вопрос, команды и оба исхода');
    r.ok(S.symptoms.length >= 8 && S.symptoms.every(function (row) { return row.length === 3; }),
      'словарь признаков атаки: признак → что значит → чем проверить');
    r.ok(S.principles.length >= 4, 'сформулированы принципы реакции');
    /* уроки раздела получают именно этот алгоритм, а не диагностический */
    var secLesson = NET.lessons.forLab('sec01');
    r.ok(!!secLesson && NET.method.playbookFor(secLesson.id) === S,
      'уроки раздела «Безопасность» используют алгоритм реакции');
    var diagLesson = NET.lessons.forLab('lab01');
    r.ok(!!diagLesson && NET.method.playbookFor(diagLesson.id) === NET.method.universal,
      'уроки диагностики используют алгоритм поиска неисправности');
  }

  /* ---------- методическая часть уроков ---------- */

  function firstWord(cmd) {
    return String(cmd).replace(/^sudo\s+/, '').trim().split(/[\s|]/)[0];
  }

  function testMethod(r) {
    r.section('method: алгоритм, сценарии, практика, вопросы');
    var U = NET.method.universal;
    r.ok(U.steps.length >= 8, 'универсальный алгоритм: не меньше 8 шагов', String(U.steps.length));
    r.ok(U.steps.every(function (st) { return st.layer && st.q && st.cmds.length && st.pass && st.fail; }),
      'у каждого шага алгоритма есть вопрос, команды и оба исхода');
    r.ok(U.symptoms.length >= 8 && U.symptoms.every(function (row) { return row.length === 3; }),
      'словарь симптомов: сообщение → причина → проверка');

    var missing = [];
    NET.labs.list().forEach(function (lab) {
      var lesson = NET.lessons.forLab(lab.id);
      if (!lesson || !NET.method.get(lesson.id)) missing.push(lab.id);
    });
    r.ok(missing.length === 0, 'у каждой лабораторной есть методическая часть', missing.join(', '));

    var bad = [];
    NET.method.ids().forEach(function (id) {
      var m = NET.method.get(id);
      var where = id + ': ';
      if (!NET.lessons.get(id)) bad.push(where + 'нет урока');
      if (!(m.minutes > 0 && m.minutes < 30)) bad.push(where + 'время чтения');

      if (m.commands.length < 5) bad.push(where + 'меньше 5 команд в разборе');
      m.commands.forEach(function (c) {
        if (!c.shows || !c.why || !(c.read && c.read.length >= 1)) bad.push(where + c.cmd + ': нет «что/зачем/как читать»');
        var w = firstWord(c.cmd);
        if (!NET.commands.get(w)) bad.push(where + 'команда «' + w + '» не реализована');
      });

      var sc = m.scenario;
      if (!sc || !sc.symptom || sc.hypotheses.length < 2 || sc.checks.length < 2 || !sc.localize ||
        !sc.fix.length || !sc.verify.length || !sc.transfer) {
        bad.push(where + 'сценарий неполон (симптом → гипотезы → проверки → локализация → исправление → проверка)');
      } else {
        sc.checks.forEach(function (row) { if (row.length !== 3) bad.push(where + 'проверка сценария не из трёх частей'); });
      }

      if (m.practice.length < 4) bad.push(where + 'меньше 4 шагов практики');
      m.practice.forEach(function (st, i) {
        if (!st.expect || !st.ask) bad.push(where + 'практика ' + (i + 1) + ': нет ожидаемого результата или вопроса');
        if (st.sees === undefined && st.absent === undefined) bad.push(where + 'практика ' + (i + 1) + ': нечем сверить вывод');
        var w = firstWord(st.cmd);
        if (!NET.commands.get(w)) bad.push(where + 'практика: команда «' + w + '» не реализована');
      });
      if (!m.solution || !m.solution.steps.length || !m.solution.verify.length) bad.push(where + 'нет решения или его проверки');

      if (m.checklist.length < 5) bad.push(where + 'чек-лист короче 5 пунктов');
      if (m.questions.length < 4) bad.push(where + 'меньше 4 контрольных вопросов');
      m.questions.forEach(function (qa) { if (!qa.q || !qa.a || qa.a.length < 40) bad.push(where + 'вопрос без содержательного ответа'); });
    });
    r.ok(bad.length === 0, 'структура методической части корректна', bad.slice(0, 4).join('; '));
  }

  /* ---------- тесты по командам ---------- */

  function testQuiz(r) {
    r.section('quiz: тесты по командам');
    var missing = NET.lessons.ids().filter(function (id) { return !NET.quiz.has(id); });
    r.ok(missing.length === 0, 'тест есть у каждого урока', missing.join(', '));

    var bad = [];
    NET.quiz.ids().forEach(function (id) {
      var qz = NET.quiz.get(id);
      if (qz.kind === 'lesson' && !NET.lessons.get(id)) bad.push(id + ': нет ни урока, ни описания темы');
      if (qz.questions.length < 8) bad.push(id + ': меньше 8 вопросов');
      var seen = {};
      qz.questions.forEach(function (q, i) {
        var tag = id + ' #' + (i + 1) + ': ';
        if (seen[q.q]) bad.push(tag + 'повтор вопроса');
        seen[q.q] = true;
        if (!(q.options.length >= 3 && q.options.length <= 5)) bad.push(tag + 'вариантов не 3–5');
        var uniq = {};
        q.options.forEach(function (o) { uniq[o] = true; });
        if (Object.keys(uniq).length !== q.options.length) bad.push(tag + 'одинаковые варианты');
        if (!(q.answer >= 0 && q.answer < q.options.length)) bad.push(tag + 'индекс ответа вне диапазона');
        if (!q.explain || q.explain.length < 20) bad.push(tag + 'нет объяснения');
        if (!NET.commands.get(firstWord(q.cmd))) bad.push(tag + 'команда «' + q.cmd + '» не реализована');
      });
    });
    r.ok(bad.length === 0, 'вопросы тестов корректны', bad.slice(0, 4).join('; '));

    /* Каталог тем: раздел «Тесты» собирается из данных, поэтому тема без
       описания или с чужой группой просто исчезла бы из интерфейса. */
    var groupIds = {};
    NET.quiz.groups().forEach(function (g) { groupIds[g.id] = true; });
    var inCatalog = {};
    NET.quiz.catalog().forEach(function (g) {
      g.topics.forEach(function (t) { inCatalog[t.id] = true; });
    });
    var seenTitle = {};
    var badTopics = [];
    NET.quiz.topicIds().forEach(function (id) {
      var t = NET.quiz.get(id);
      if (!t.title || !t.desc) badTopics.push(id + ': нет названия или описания темы');
      if (!groupIds[t.group]) badTopics.push(id + ': раздел «' + t.group + '» не объявлен');
      if (!inCatalog[id]) badTopics.push(id + ': тема не попала в каталог');
      if (seenTitle[t.title]) badTopics.push(id + ': повтор названия темы');
      seenTitle[t.title] = true;
      if (!NET.quiz.commandsOf(id).length) badTopics.push(id + ': вопросы не привязаны к командам');
    });
    r.ok(NET.quiz.topicIds().length >= 12, 'каталог покрывает не меньше 12 тем',
      String(NET.quiz.topicIds().length));
    r.ok(NET.quiz.catalog().length >= 3, 'разделов каталога не меньше трёх',
      String(NET.quiz.catalog().length));
    r.ok(badTopics.length === 0, 'темы каталога описаны и разложены по разделам',
      badTopics.slice(0, 4).join('; '));
    r.ok(NET.quiz.lessonIds().length === NET.lessons.ids().length,
      'тесты к урокам не смешаны с темами каталога');

    /* Охват: основные группы команд тренажёра должны где-то спрашиваться. */
    var asked = {};
    NET.quiz.topicIds().forEach(function (id) {
      NET.quiz.commandsOf(id).forEach(function (c) { asked[c] = true; });
    });
    var mustAsk = ['ls', 'grep', 'sed', 'awk', 'chmod', 'ps', 'systemctl', 'journalctl', 'apt',
      'sysctl', 'ip', 'netplan', 'ping', 'traceroute', 'ss', 'curl', 'dig', 'tcpdump',
      'ufw', 'iptables', 'sshd', 'find'];
    var notAsked = mustAsk.filter(function (c) { return !asked[c]; });
    r.ok(notAsked.length === 0, 'основные команды охвачены тестами', notAsked.join(', '));

    var qz = NET.quiz.get('lab01');
    var all = qz.questions.map(function (q) { return q.answer; });
    var full = NET.quiz.grade('lab01', all);
    r.ok(full.percent === 100 && full.passed && full.wrong.length === 0, 'все верные ответы — 100% и зачёт');
    var none = NET.quiz.grade('lab01', qz.questions.map(function () { return null; }));
    r.ok(none.percent === 0 && !none.passed && none.wrong.length === qz.questions.length, 'без ответов — 0%');
    r.ok(NET.quiz.grade('нет-такого', []) === null, 'несуществующий тест — null');

    var before = NET.progress.quizResult('lab01');
    NET.progress.recordQuiz('lab01', 50);
    NET.progress.recordQuiz('lab01', 88);
    NET.progress.recordQuiz('lab01', 25);
    var res = NET.progress.quizResult('lab01');
    r.ok(res && res.best === 88 && res.tries >= 3, 'сохраняется лучший результат и число попыток');
    NET.progress.recordQuiz('lab01', 'abc');
    r.ok(NET.progress.quizResult('lab01').best === 88, 'мусорный процент не портит результат');
    if (!before) {
      var rec = NET.progress.get().lessons.lab01;
      delete rec.quizBest; delete rec.quizTries; delete rec.quizAt;
    }
  }

  /* ---------- схема хранилища ---------- */

  function testSchema(r) {
    r.section('schema: валидация сохранённых данных');
    var res = NET.schema.validate('userProgress', { version: 1, labs: 'сломано', skills: null, totals: 42 });
    r.ok(res.data && typeof res.data.labs === 'object' && !Array.isArray(res.data.labs),
      'повреждённый раздел восстанавливается структурой по умолчанию');
    r.ok(res.repaired.length > 0, 'исправления перечислены для журнала');
    r.eq(typeof res.data.totals.labsSolved, 'number', 'счётчики приводятся к числам');

    var hostile = NET.schema.validate('userProgress',
      JSON.parse('{"version":2,"labs":{"__proto__":{"solved":true},"lab01":{"solved":"да"}}}'));
    r.ok(({}).solved === undefined, 'валидация не загрязняет прототип');
    r.ok(hostile.data.labs.lab01.solved === false,
      'непонятное значение не засчитывает лабораторию как решённую');

    r.ok(NET.schema.blank('settings').mode === 'learn', 'пустые настройки имеют разумные значения');
    r.eq(NET.schema.validate('learningHistory', { version: 2, entries: 'нет' }).data.entries.length, 0,
      'битый журнал обучения не ломает загрузку');
    var noKind = NET.schema.validate('нет-такого', {});
    r.ok(noKind.data === null, 'неизвестный раздел отклоняется без исключения');
  }

  /* ---------- лаборатории ---------- */

  /*
   * Контракт лаборатории: всё, без чего сценарий нельзя выпускать. Проверка
   * ловит типичные забытые при добавлении вещи — ссылку на несуществующую
   * врезку, отсутствие урока/методички/теста, команду решения, которой нет.
   */
  function testLabContract(r, labs) {
    var bad = [];
    var ids = {};
    labs.forEach(function (lab) {
      var where = lab.id + ': ';
      if (ids[lab.id]) bad.push(where + 'повтор id');
      ids[lab.id] = true;
      if (!(lab.difficulty >= 1 && lab.difficulty <= 5 && lab.difficulty % 1 === 0)) bad.push(where + 'сложность не 1–5');
      if (!lab.title || !lab.brief || !lab.goal) bad.push(where + 'нет title/brief/goal');
      if (!NET.registries.topologies[lab.topology]) bad.push(where + 'неизвестная топология ' + lab.topology);
      (lab.skills || []).forEach(function (s) { if (!NET.skills.get(s)) bad.push(where + 'неизвестный навык ' + s); });
      var lesson = NET.lessons.forLab(lab.id);
      if (!lesson) bad.push(where + 'нет урока');
      else if (!NET.quiz.has(lesson.id)) bad.push(where + 'нет теста к уроку');
      /* заготовка tools/new-lab.js помечает незаполненное словом TODO */
      var texts = [lab, lesson, lesson && NET.method.get(lesson.id), lesson && NET.quiz.get(lesson.id)];
      NET.labs.variants(lab).forEach(function (v) {
        var th = v.debrief && v.debrief.theory;
        if (th) texts.push(NET.theory.get(th));
      });
      if (JSON.stringify(texts).indexOf('TODO') >= 0) bad.push(where + 'остались незаполненные TODO');
      NET.labs.variants(lab).forEach(function (v) {
        var th = v.debrief && v.debrief.theory;
        if (th && !NET.theory.get(th)) bad.push(v.id + ': врезка «' + th + '» не найдена в theory');
        if (!th) bad.push(v.id + ': в разборе нет ссылки на врезку теории (debrief.theory)');
        (v.solution || []).forEach(function (line) {
          var w = firstWord(line);
          if (w && !NET.commands.get(w)) bad.push(v.id + ': команда решения «' + w + '» не реализована');
        });
      });
    });
    r.ok(bad.length === 0, 'контракт лабораторий: сложность, урок, тест, врезки, команды решений',
      bad.slice(0, 5).join('; '));
  }

  function testLabs(r) {
    r.section('labs: сценарии действительно ломают мир');
    var labs = NET.labs.list();
    r.ok(labs.length >= 20, 'зарегистрировано не меньше 20 лабораторий', String(labs.length));
    /* каждый раздел курса наполнен */
    NET.labs.tracks.forEach(function (t) {
      r.ok(NET.labs.byTrack(t.id).length >= 5, 'раздел «' + t.title + '»: не меньше 5 лабораторий',
        String(NET.labs.byTrack(t.id).length));
    });
    var secLevels = {};
    NET.labs.byTrack('security').forEach(function (lab) { secLevels[lab.difficulty] = true; });
    r.ok([1, 2, 3, 4, 5].every(function (d) { return secLevels[d]; }),
      'в разделе «Безопасность» есть задача каждого уровня ★1–★5', Object.keys(secLevels).join(','));
    var levels = {};
    labs.forEach(function (lab) { levels[lab.difficulty] = (levels[lab.difficulty] || 0) + 1; });
    r.ok([1, 2, 3, 4, 5].every(function (d) { return levels[d] >= 2; }),
      'на каждом уровне сложности ★1–★5 не меньше двух лабораторий', JSON.stringify(levels));
    testLabContract(r, labs);

    labs.forEach(function (lab) {
      var variants = NET.labs.variants(lab);
      variants.forEach(function (v, idx) {
        var res = NET.labs.start(lab.id, { variant: idx });
        if (!r.ok(!res.err, lab.id + '/' + idx + ': сценарий запускается', res.err)) return;
        var check = NET.labs.check();
        var failedCount = check.results.filter(function (x) { return !x.ok; }).length;
        r.ok(!check.solved && failedCount > 0,
          lab.id + ' (' + v.name + '): поломка присутствует, проверка не проходит',
          'проваленных проверок: ' + failedCount);
        r.ok((v.hints || []).length >= 2, lab.id + ' (' + v.name + '): есть подсказки');
        r.ok((v.keySteps || []).length >= 3, lab.id + ' (' + v.name + '): описаны шаги диагностики');
        r.ok(!!(v.debrief && v.debrief.why), lab.id + ' (' + v.name + '): есть разбор');
      });
    });

    /* сквозная проверка: lab01 решается добавлением маршрута */
    NET.labs.start('lab01', { variant: 0 });
    var m = NET.world.get('srv1');
    m.net.addRoute({ dst: 'default', gw: '192.168.10.1', dev: 'ens33', proto: 'static', metric: 100 });
    var after = NET.labs.check();
    r.ok(after.solved, 'lab01 решается добавлением default route');
    if (after.solved && after.report) {
      r.ok(after.report.score > 0 && after.report.score <= 100, 'оценка в допустимых пределах');
      r.ok(!!after.report.debrief.why, 'в отчёт попал разбор');
    }

    /* reset возвращает поломку */
    NET.labs.start('lab05', { variant: 0 });
    var before = NET.labs.check();
    NET.world.get('srv1').fw.ufw.enabled = false;
    var fixed = NET.labs.check();
    NET.labs.reset();
    var afterReset = NET.labs.check();
    r.ok(!before.solved && fixed.solved && !afterReset.solved,
      'reset восстанавливает исходное состояние задачи');

    /* банк коротких задач */
    var tasks = NET.taskPool.list();
    r.ok(tasks.length >= 30, 'в банке не меньше 30 коротких заданий', 'сейчас ' + tasks.length);
    var cmdTask = NET.taskPool.get('ct-ip-br');
    r.ok(NET.taskPool.check(cmdTask, NET.world, [{ line: 'ip -br a' }]).ok,
      'Command Trainer принимает верную команду');
    r.ok(!NET.taskPool.check(cmdTask, NET.world, [{ line: 'ifconfig' }]).ok,
      'Command Trainer отвергает неверную команду');
    var stTask = NET.taskPool.get('st-iface-up');
    var w = freshWorld();
    stTask.setup(w);
    r.ok(!NET.taskPool.check(stTask, w, []).ok, 'задание на состояние: поломка внесена');
    w.get('srv1').net.setLink('ens33', { up: true });
    r.ok(NET.taskPool.check(stTask, w, []).ok, 'задание на состояние: исправление засчитано');

    NET.labs.stop();
  }

  NET.selftest = { run: run };
})(window.NET);
