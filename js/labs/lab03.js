/* Lab 03 — маршрутизация до удалённой подсети. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var checks = [
    C.canPing('srv1', '10.20.5.10', 'Сеть филиала'),
    C.tcpOpen('srv1', '10.20.5.10', 80, 'HTTP филиала'),
    C.canPing('srv1', '8.8.8.8', 'Интернет (не сломать)')
  ];

  var keySteps = [
    { id: 'route', title: 'Изучить таблицу маршрутов', match: /^ip\s+(-\w+\s+)*(r|route)\b/ },
    { id: 'routeget', title: 'Проверить выбор маршрута (ip route get)', match: /ip\s+(r|route)\s+get\b/ },
    { id: 'ping', title: 'Проверить доступность цели', match: /^(ping|traceroute|tracepath|mtr)\b.*10\.20\./ },
    { id: 'neigh', title: 'Проверить ARP/соседей', match: /^(ip\s+(n|neigh)|arp)\b/ }
  ];

  NET.labs.register({
    id: 'lab03',
    title: 'Исправь routing',
    difficulty: 2,
    skills: ['routing', 'networking', 'troubleshooting', 'tcpip'],
    topology: 'campus',
    brief: 'Сервер srv1 имеет корректный адрес и выходит в интернет,\n' +
      'но не может достучаться до сети филиала 10.20.0.0/16 (сервер 10.20.5.10).\n\n' +
      'Маршрут до филиала идёт через шлюз 192.168.10.1 и далее через rtr2 (10.99.0.2).',
    goal: 'ping и HTTP до 10.20.5.10 работают, интернет не сломан.',

    setup: function (world, h) {
      var m = world.get('srv1');
      m.net.addRoute({
        dst: '10.20.0.0', prefix: 16, gw: '192.168.10.254', dev: 'ens33',
        proto: 'static', metric: 100
      });
      h.log('srv1', 'systemd-networkd', 'ens33: route to 10.20.0.0/16 configured');
    },

    keySteps: keySteps,
    checks: checks,

    hints: [
      'Интернет работает, а конкретная подсеть — нет. Значит, для неё выбирается отдельный маршрут: ' +
        'посмотрите `ip route` и особенно `ip route get 10.20.5.10`.',
      'Есть более специфичный маршрут 10.20.0.0/16 (префикс /16 длиннее, чем /0), поэтому он выигрывает у default. ' +
        'Проверьте, существует ли его шлюз: `ping 192.168.10.254`, `ip neigh`.',
      'Шлюз 192.168.10.254 не существует. Удалите ошибочный маршрут: ' +
        '`sudo ip route del 10.20.0.0/16 via 192.168.10.254` — трафик пойдёт через default на 192.168.10.1. ' +
        'Или задайте правильный: `sudo ip route replace 10.20.0.0/16 via 192.168.10.1`.'
    ],

    debrief: {
      why: 'Ядро выбирает маршрут по правилу longest prefix match: запись /16 всегда побеждает default /0. ' +
        'Ошибочный «более специфичный» маршрут перехватывал трафик и отправлял его на несуществующий next-hop, ' +
        'из-за чего ARP не разрешался и появлялось «Destination Host Unreachable». ' +
        'Интернет при этом работал — типичная картина «частичной» потери связности.',
      commands: [
        ['ip route', 'увидеть все маршруты, включая лишние'],
        ['ip route get 10.20.5.10', 'ядро само сообщает, какой маршрут и next-hop выбраны'],
        ['ip neigh', 'INCOMPLETE/FAILED подтверждает, что next-hop мёртв'],
        ['sudo ip route del 10.20.0.0/16 via 192.168.10.254', 'убрать ошибочный маршрут'],
        ['traceroute -n 10.20.5.10', 'проверить путь после исправления']
      ],
      theory: 'longest-prefix-match'
    },

    mutations: [
      {
        name: 'нет маршрута на шлюзе',
        brief: 'srv1 не видит сеть филиала 10.20.0.0/16. На самом сервере маршруты выглядят нормально.\n' +
          'Доступ к шлюзу есть: `connect gw`.',
        setup: function (world, h) {
          var gw = world.get('gw');
          gw.net.delRoute({ dst: '10.20.0.0', prefix: 16 });
          h.log('gw', 'kernel', 'route to 10.20.0.0/16 removed');
        },
        hints: [
          'На srv1 маршрутов только два — default и connected. Значит трафик уходит на шлюз: проверьте `traceroute -n 10.20.5.10`.',
          'Трассировка обрывается на 192.168.10.1 — дальше шлюз не знает, куда слать. Зайдите: `connect gw`, затем `ip route`.',
          'На gw: `sudo ip route add 10.20.0.0/16 via 10.99.0.2 dev ens35`.'
        ],
        debrief: {
          why: 'Хост отдаёт незнакомый трафик шлюзу по default route. Если шлюз сам не знает маршрута до сети назначения, ' +
            'он отвечает ICMP Network Unreachable или молча отбрасывает пакет. Диагностика хоста тут ничего не даст — ' +
            'нужно смотреть на следующем устройстве по пути, и traceroute точно указывает, где обрывается путь.',
          commands: [
            ['traceroute -n 10.20.5.10', 'определить последний отвечающий узел'],
            ['connect gw', 'перейти на шлюз'],
            ['ip route', 'на шлюзе — маршрута до 10.20.0.0/16 нет'],
            ['sudo ip route add 10.20.0.0/16 via 10.99.0.2 dev ens35', 'добавить маршрут']
          ],
          theory: 'routing-basics'
        }
      }
    ]
  });
})(window.NET);
