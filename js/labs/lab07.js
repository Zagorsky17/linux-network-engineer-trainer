/* Lab 07 — интерфейс не получает адрес по DHCP. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var gotLease = C.custom('srv1 получил адрес по DHCP из 192.168.10.0/24', function (world) {
    var m = world.get('srv1');
    var found = null;
    m.net.ifaces.forEach(function (i) {
      i.addrs.forEach(function (a) {
        if (a.family === 4 && a.dynamic && NET.util.inSubnet(a.ip, '192.168.10.0/24')) found = { i: i, a: a };
      });
    });
    return { ok: !!found, detail: found ? null : 'динамического адреса нет ни на одном интерфейсе' };
  });

  NET.labs.register({
    id: 'lab07',
    title: 'DHCP: интерфейс не получает IP',
    difficulty: 3,
    skills: ['dhcp', 'networking', 'troubleshooting', 'services'],
    topology: 'campus',
    brief: 'srv1 переведён на получение адреса по DHCP, но после загрузки остаётся без IPv4-адреса.\n' +
      'DHCP-сервер работает на шлюзе gw (пул 192.168.10.100–150). Доступ к gw есть: `connect gw`.\n\n' +
      'Найдите причину и добейтесь получения адреса.',
    goal: 'srv1 получает адрес по DHCP и выходит в интернет.',

    setup: function (world, h) {
      h.writeNetplan('srv1', {
        network: {
          version: 2, renderer: 'networkd',
          ethernets: { ens33: { dhcp4: true } }
        }
      });
      var m = world.get('srv1');
      m.net.flushAddrs('ens33');
      m.net.routes = m.net.routes.filter(function (r) { return r.dev !== 'ens33'; });
      m.net.setLink('ens33', { up: true });
      m.setResolvConf([], []);
      world.get('gw').services.stop('isc-dhcp-server');
      h.log('srv1', 'systemd-networkd', 'ens33: DHCPv4 client: Failed to get lease, retrying');
      h.log('gw', 'systemd', 'isc-dhcp-server.service: Deactivated successfully.');
    },

    keySteps: [
      { id: 'link', title: 'Проверить интерфейс и линк', match: /(ip\s+(-\w+\s+)*(l|link|a|addr)|ethtool)/ },
      { id: 'client', title: 'Попробовать получить адрес вручную (dhclient/netplan apply)', match: /(dhclient|netplan\s+apply)/ },
      { id: 'logs', title: 'Посмотреть логи клиента', match: /^(journalctl|cat|grep|tail)\b/ },
      { id: 'server', title: 'Проверить сервер DHCP', match: /(connect\s+gw|systemctl\s+(status|start).*dhcp|ss\s+.*(67|-u))/ },
      { id: 'capture', title: 'Посмотреть DHCP-трафик (tcpdump port 67)', match: /tcpdump[^|]*\b(67|68|bootp)/ }
    ],

    checks: [
      gotLease,
      C.serviceActive('gw', 'isc-dhcp-server'),
      C.canPing('srv1', '192.168.10.1', 'Шлюз'),
      C.canPing('srv1', '8.8.8.8', 'Интернет')
    ],

    hints: [
      'Сначала убедитесь, что проблема не на клиенте: `ip -br a` (адреса нет), `ip link show ens33` (есть ли UP и carrier), ' +
        'затем `sudo dhclient -v ens33` — посмотрите, приходят ли DHCPOFFER.',
      'Клиент шлёт DISCOVER, но «No DHCPOFFERS received». Значит, никто не отвечает в этом сегменте: ' +
        'проверьте сервер — `connect gw`, `systemctl status isc-dhcp-server`, `ss -lunp | grep :67`.',
      'На gw: `sudo systemctl enable --now isc-dhcp-server`. Затем на srv1: `sudo dhclient -v ens33` или `sudo netplan apply`.'
    ],

    debrief: {
      why: 'DHCP — это широковещательный обмен DISCOVER → OFFER → REQUEST → ACK внутри L2-сегмента. ' +
        'Отсутствие OFFER означает одно из трёх: клиент физически не в том сегменте (линк/VLAN), ' +
        'сервер не работает или не слушает 67/udp, либо ответ отфильтрован. ' +
        'Разделить эти случаи помогает tcpdump: видно, уходит ли DISCOVER и приходит ли OFFER.',
      commands: [
        ['ip link show ens33', 'есть ли UP и LOWER_UP (carrier)'],
        ['sudo dhclient -v ens33', 'ручная попытка с подробным выводом'],
        ['sudo tcpdump -i ens33 -n port 67 or port 68', 'видно DISCOVER без OFFER'],
        ['connect gw && systemctl status isc-dhcp-server', 'состояние сервера'],
        ['ss -lunp | grep :67', 'слушает ли сервер нужный порт'],
        ['sudo systemctl enable --now isc-dhcp-server', 'запуск и автозапуск']
      ],
      theory: 'dhcp-flow'
    },

    mutations: [
      {
        name: 'нет линка на основном интерфейсе',
        brief: 'srv1 не получает адрес по DHCP. DHCP-сервер на gw работает и раздаёт адреса другим хостам.\n' +
          'На сервере два интерфейса: ens33 и ens34. Добейтесь получения адреса.',
        setup: function (world, h) {
          h.writeNetplan('srv1', {
            network: { version: 2, renderer: 'networkd', ethernets: { ens33: { dhcp4: true } } }
          });
          var m = world.get('srv1');
          m.net.flushAddrs('ens33');
          m.net.routes = m.net.routes.filter(function (r) { return r.dev !== 'ens33'; });
          m.setResolvConf([], []);
          m.net.setLink('ens33', { carrier: false });
          h.log('srv1', 'kernel', 'ens33: Link is Down');
        },
        hints: [
          '`ip link show ens33` — флаг NO-CARRIER. Подтвердите железом: `ethtool ens33` → Link detected: no.',
          'Кабель в порт ens33 не подключён. Второй порт ens34 физически подключён к тому же коммутатору: сравните `ethtool ens34`.',
          'Переведите конфигурацию на рабочий интерфейс: в netplan замените ens33 на ens34 (dhcp4: true) и выполните `sudo netplan apply`.'
        ],
        debrief: {
          why: 'Отсутствие carrier — проблема физического уровня: интерфейс нельзя «поднять» программно, ' +
            'DHCP-клиент даже не отправит DISCOVER. ethtool отделяет «порт выключен администратором» ' +
            'от «кабеля нет»: в первом случае state DOWN, во втором — NO-CARRIER и Link detected: no.',
          commands: [
            ['ip -br link', 'быстро увидеть NO-CARRIER'],
            ['ethtool ens33', 'Link detected: no — физика'],
            ['ethtool ens34', 'исправный порт'],
            ['sudo netplan apply', 'после переноса конфигурации на ens34']
          ],
          theory: 'layer1-carrier'
        }
      },
      {
        name: 'DHCP фильтруется на сервере',
        brief: 'srv1 не получает адрес. Сервис isc-dhcp-server на gw запущен и слушает порт,\n' +
          'но клиенты не получают ответов. Найдите причину.',
        setup: function (world, h) {
          h.writeNetplan('srv1', {
            network: { version: 2, renderer: 'networkd', ethernets: { ens33: { dhcp4: true } } }
          });
          var m = world.get('srv1');
          m.net.flushAddrs('ens33');
          m.net.routes = m.net.routes.filter(function (r) { return r.dev !== 'ens33'; });
          m.setResolvConf([], []);
          m.net.setLink('ens33', { up: true });
          var gw = world.get('gw');
          gw.fw.addRule('INPUT', { proto: 'udp', dport: 67, target: 'DROP', comment: 'block-dhcp' }, {});
        },
        hints: [
          'Сервис запущен, порт слушается — значит пакеты не доходят до демона. Проверьте фильтр на gw.',
          'На gw: `sudo iptables -L INPUT -n --line-numbers` — найдите правило для udp/67.',
          '`sudo iptables -D INPUT -p udp --dport 67 -j DROP`, затем на srv1 `sudo dhclient -v ens33`.'
        ]
      }
    ]
  });
})(window.NET);
