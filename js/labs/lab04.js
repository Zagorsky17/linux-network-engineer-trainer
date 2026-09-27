/* Lab 04 — DNS не резолвит, хотя IP доступны. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var checks = [
    C.canPing('srv1', '8.8.8.8', 'IP-связность (должна остаться)'),
    C.resolves('srv1', 'app1.corp.local', '192.168.10.30'),
    C.resolves('srv1', 'www.example.com', '93.184.216.34'),
    C.tcpOpen('srv1', '93.184.216.34', 80, 'HTTP по имени')
  ];

  var keySteps = [
    { id: 'ping-ip', title: 'Убедиться, что IP работает', match: /^ping\b.*(8\.8\.8\.8|93\.184|192\.168\.10\.\d)/ },
    { id: 'resolvconf', title: 'Посмотреть /etc/resolv.conf', match: /(cat|less|head|grep).*resolv\.conf|resolvectl/ },
    { id: 'dig', title: 'Проверить DNS напрямую (dig/host/nslookup)', match: /^(dig|host|nslookup)\b/ },
    { id: 'dig-server', title: 'Спросить конкретный сервер (dig @server)', match: /dig\s+@\S+/ }
  ];

  NET.labs.register({
    id: 'lab04',
    title: 'DNS troubleshooting',
    difficulty: 2,
    skills: ['dns', 'troubleshooting', 'networking', 'services'],
    topology: 'campus',
    brief: 'На srv1 «интернет работает по IP, но сайты не открываются».\n' +
      'ping 8.8.8.8 проходит, а любое доменное имя не разрешается.\n\n' +
      'Найдите, на каком этапе ломается разрешение имён, и почините так, чтобы работало и после перезагрузки.',
    goal: 'Имена corp.local и внешние домены разрешаются с srv1.',

    setup: function (world, h) {
      h.writeNetplan('srv1', {
        network: {
          version: 2, renderer: 'networkd',
          ethernets: {
            ens33: {
              addresses: ['192.168.10.20/24'],
              routes: [{ to: 'default', via: '192.168.10.1' }],
              nameservers: { addresses: ['192.168.10.55'], search: ['corp.local'] }
            }
          }
        }
      });
      h.applyNetplan('srv1');
      world.get('srv1').setResolvConf(['192.168.10.55'], ['corp.local']);
    },

    keySteps: keySteps,
    checks: checks,

    hints: [
      'Раздели задачу: IP-связность отдельно, разрешение имён отдельно. Посмотрите, какой сервер используется: ' +
        '`cat /etc/resolv.conf` или `resolvectl status`.',
      'Резолвер указывает на 192.168.10.55. Существует ли такой сервер? Сравните: `dig @192.168.10.55 app1.corp.local` ' +
        'и `dig @192.168.10.5 app1.corp.local`.',
      'Рабочий DNS — 192.168.10.5. Пропишите его в nameservers в /etc/netplan/01-netcfg.yaml и выполните `sudo netplan apply`.'
    ],

    debrief: {
      why: 'Разрешение имён — отдельная подсистема поверх IP. Клиент берёт адрес сервера из /etc/resolv.conf ' +
        '(в Ubuntu его обычно наполняет systemd-resolved по данным netplan/DHCP) и шлёт UDP-запрос на порт 53. ' +
        'Если сервер не существует или не отвечает, симптом — таймаут запроса, а не отказ; ' +
        '`dig @<сервер>` позволяет проверить конкретный сервер, минуя конфигурацию.',
      commands: [
        ['ping -c2 8.8.8.8', 'убедиться, что IP-уровень исправен'],
        ['cat /etc/resolv.conf', 'какой сервер реально используется'],
        ['resolvectl status', 'что знает systemd-resolved (upstream, домены поиска)'],
        ['dig @192.168.10.5 app1.corp.local', 'проверить рабочий сервер напрямую'],
        ['sudo netplan apply', 'зафиксировать корректный nameservers']
      ],
      theory: 'dns-resolution',
      pitfalls: [
        '/etc/resolv.conf часто является симлинком и перезаписывается — править надо источник (netplan/NM/DHCP).',
        'NXDOMAIN, SERVFAIL и таймаут — три разные причины; смотрите status: в выводе dig.'
      ]
    },

    mutations: [
      {
        name: 'DNS-сервер не запущен',
        brief: 'Перестали разрешаться имена corp.local (внешние домены тоже).\n' +
          'Конфигурация клиента не менялась. Доступ к DNS-серверу есть: `connect dns1`.',
        setup: function (world, h) {
          /* в корпоративной сети прописан единственный внутренний резолвер */
          h.writeNetplan('srv1', {
            network: {
              version: 2, renderer: 'networkd',
              ethernets: {
                ens33: {
                  addresses: ['192.168.10.20/24'],
                  routes: [{ to: 'default', via: '192.168.10.1' }],
                  nameservers: { addresses: ['192.168.10.5'], search: ['corp.local'] }
                }
              }
            }
          });
          h.applyNetplan('srv1');
          world.get('dns1').services.stop('named');
          h.log('dns1', 'systemd', 'named.service: Deactivated successfully.');
        },
        hints: [
          '`dig app1.corp.local` — обратите внимание, что именно возвращается: таймаут, SERVFAIL или NXDOMAIN.',
          'Запросы к 192.168.10.5 уходят в никуда. Хост пингуется? Тогда проверьте сам сервис: `connect dns1`, `ss -lunp | grep :53`.',
          'На dns1: `sudo systemctl start named` и `sudo systemctl enable named`, затем проверьте `systemctl status named`.'
        ],
        debrief: {
          why: 'DNS-сервер был доступен по IP, но демон не слушал порт 53, поэтому UDP-запросы оставались без ответа ' +
            '(таймаут, а не отказ: для UDP закрытый порт даёт ICMP port unreachable, но фильтр часто его гасит). ' +
            'Проверка «есть ли слушающий сокет» — обязательный шаг при диагностике любого сервиса.',
          commands: [
            ['dig app1.corp.local', 'видим communications error / timed out'],
            ['ping -c2 192.168.10.5', 'сам хост жив — значит дело в сервисе'],
            ['connect dns1 && ss -lunp', 'порт 53 никем не слушается'],
            ['systemctl status named', 'юнит inactive'],
            ['sudo systemctl enable --now named', 'запустить и включить автозапуск']
          ],
          theory: 'dns-resolution'
        }
      },
      {
        name: 'systemd-resolved остановлен',
        brief: 'На srv1 внезапно перестали резолвиться любые имена.\n' +
          'В /etc/resolv.conf указан 127.0.0.53 — «как обычно». IP-связность в порядке.',
        setup: function (world, h) {
          var m = world.get('srv1');
          m.resolved.upstream = ['192.168.10.5', '8.8.8.8'];
          m.setResolvConf(['127.0.0.53'], ['corp.local'], true);
          m.services.stop('systemd-resolved');
        },
        hints: [
          '127.0.0.53 — это локальная заглушка systemd-resolved. Кто её слушает? `ss -lunp | grep 53`.',
          'Сокет на 127.0.0.53:53 отсутствует — сам резолвер не работает: `systemctl status systemd-resolved`.',
          '`sudo systemctl start systemd-resolved` (проверьте также `resolvectl status`).'
        ]
      }
    ]
  });
})(window.NET);
