/* Lab 01 — сервер не выходит в интернет. Базовая методика «снизу вверх». */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var checks = [
    C.canPing('srv1', '192.168.10.1', 'Шлюз'),
    C.canPing('srv1', '8.8.8.8', 'Интернет'),
    C.resolves('srv1', 'www.example.com', '93.184.216.34'),
    C.tcpOpen('srv1', '93.184.216.34', 80, 'HTTP наружу')
  ];

  var keySteps = [
    { id: 'link', title: 'Проверить состояние интерфейса (ip link / ip a)', match: /^ip\s+(-\w+\s+)*(a|addr|address|l|link)\b/, weight: 2 },
    { id: 'route', title: 'Посмотреть таблицу маршрутов (ip route)', match: /^ip\s+(-\w+\s+)*(r|route)\b/, weight: 3 },
    { id: 'ping-gw', title: 'Проверить связь со шлюзом', match: /^ping\b.*192\.168\.10\.1\b/, weight: 2 },
    { id: 'ping-ext', title: 'Проверить связь с внешним IP', match: /^ping\b.*(8\.8\.8\.8|1\.1\.1\.1)/, weight: 2 },
    { id: 'dns', title: 'Проверить разрешение имён (dig/host/nslookup)', match: /^(dig|host|nslookup|resolvectl)\b/, weight: 1 }
  ];

  NET.labs.register({
    id: 'lab01',
    title: 'Найди проблему с сетью',
    difficulty: 1,
    skills: ['troubleshooting', 'networking', 'routing', 'cli'],
    topology: 'campus',
    brief: 'Пользователи жалуются: с сервера srv1 «не работает интернет».\n' +
      'Известно только это. Определите причину и восстановите доступ.\n\n' +
      'Диагностируйте снизу вверх: интерфейс → адрес → маршрут → шлюз → внешний IP → DNS.',
    goal: 'ping 8.8.8.8 и обращение к www.example.com с srv1 должны работать.',

    setup: function (world, h) {
      /* Поломка «в конфиге»: из netplan убран default route, конфигурация применена. */
      h.writeNetplan('srv1', {
        network: {
          version: 2, renderer: 'networkd',
          ethernets: {
            ens33: {
              addresses: ['192.168.10.20/24'],
              nameservers: { addresses: ['192.168.10.5', '8.8.8.8'], search: ['corp.local'] }
            }
          }
        }
      });
      h.applyNetplan('srv1');
      h.log('srv1', 'systemd-networkd', 'ens33: Gained carrier');
    },

    keySteps: keySteps,
    checks: checks,

    hints: [
      'Начните снизу: `ip -br a` и `ip link` — интерфейс поднят, адрес есть? Затем `ip route`.',
      'Адрес 192.168.10.20/24 на месте, а вот таблица маршрутов подозрительно короткая. Что в ней должно быть, но чего нет?',
      'Нет маршрута по умолчанию. Временно: `sudo ip route add default via 192.168.10.1 dev ens33`. ' +
        'Постоянно — добавить в /etc/netplan/01-netcfg.yaml блок routes: - to: default / via: 192.168.10.1 и `sudo netplan apply`.'
    ],

    debrief: {
      why: 'Адрес и маска были корректны, поэтому связь внутри подсети работала (ping 192.168.10.1 проходил), ' +
        'но пакеты для чужих сетей ядру было некуда отправить: в таблице не было default route. ' +
        'Отсюда классический симптом «ping шлюза работает, ping 8.8.8.8 — Network is unreachable».',
      commands: [
        ['ip -br a', 'быстро увидеть интерфейсы, их состояние и адреса'],
        ['ip route', 'главный шаг: default route либо есть, либо нет'],
        ['ping -c2 192.168.10.1', 'отделить проблему L2/L3 внутри подсети от маршрутизации'],
        ['sudo ip route add default via 192.168.10.1 dev ens33', 'быстрое временное исправление'],
        ['sudo netplan apply', 'постоянное исправление после правки /etc/netplan/*.yaml']
      ],
      theory: 'routing-basics',
      pitfalls: [
        '`ip route add` живёт до перезагрузки — конфигурацию надо записать в netplan.',
        '«Network is unreachable» приходит от локального ядра, а не из сети: это почти всегда маршрут, а не кабель.'
      ]
    },

    mutations: [
      {
        name: 'интерфейс выключен',
        brief: 'Сервер srv1 полностью потерял связь с сетью. Пользователи жалуются, что «сервер недоступен».\n' +
          'Найдите причину и восстановите работу.',
        setup: function (world, h) {
          world.get('srv1').net.setLink('ens33', { up: false });
          h.log('srv1', 'kernel', 'ens33: Link is Down');
        },
        hints: [
          '`ip link show ens33` — обратите внимание на state и флаги.',
          'Интерфейс в состоянии DOWN: адреса на нём есть, но ядро его не использует, поэтому и маршрут неактивен.',
          '`sudo ip link set ens33 up` (или `sudo netplan apply`, который поднимет интерфейс по конфигурации).'
        ]
      },
      {
        name: 'неверный шлюз',
        brief: 'После работ подрядчика srv1 перестал выходить в интернет, хотя «настройки не менялись».\n' +
          'Адрес у сервера есть. Найдите причину.',
        setup: function (world, h) {
          h.writeNetplan('srv1', {
            network: {
              version: 2, renderer: 'networkd',
              ethernets: {
                ens33: {
                  addresses: ['192.168.10.20/24'],
                  routes: [{ to: 'default', via: '192.168.10.254' }],
                  nameservers: { addresses: ['192.168.10.5', '8.8.8.8'], search: ['corp.local'] }
                }
              }
            }
          });
          h.applyNetplan('srv1');
        },
        hints: [
          'Маршрут по умолчанию есть — а есть ли такой шлюз на самом деле? Проверьте `ping` до него и `ip neigh`.',
          'ARP для 192.168.10.254 остаётся в состоянии FAILED/INCOMPLETE — значит, хоста с таким адресом в сегменте нет.',
          'Правильный шлюз — 192.168.10.1. Исправьте via в /etc/netplan/01-netcfg.yaml и выполните `sudo netplan apply`.'
        ],
        debrief: {
          why: 'Маршрут по умолчанию существовал, но указывал на несуществующий адрес. Ядро пыталось разрешить его MAC ' +
            'через ARP, не получало ответа и возвращало «Destination Host Unreachable». Это другой симптом, ' +
            'чем «Network is unreachable» при полном отсутствии маршрута.',
          commands: [
            ['ip route', 'увидеть, куда указывает default'],
            ['ping -c2 192.168.10.254', 'проверить сам шлюз'],
            ['ip neigh', 'FAILED/INCOMPLETE в ARP — прямое доказательство, что соседа нет'],
            ['tcpdump -i ens33 -n arp', 'видно who-has без ответа']
          ],
          theory: 'arp-and-gateway'
        }
      },
      {
        name: 'обрыв на аплинке шлюза',
        brief: 'С srv1 недоступен интернет, но внутри сети всё работает.\n' +
          'У вас есть доступ и к серверу, и к шлюзу (`connect gw`). Найдите причину.',
        setup: function (world, h) {
          world.get('gw').net.setLink('ens34', { up: false });
          h.log('gw', 'kernel', 'ens34: Link is Down');
        },
        hints: [
          'С srv1 шлюз пингуется, а 8.8.8.8 — нет. Значит, проблема за шлюзом: смотрите `traceroute -n 8.8.8.8`.',
          'Зайдите на шлюз: `connect gw`, затем `ip -br a` и `ip route` — что с аплинк-интерфейсом ens34?',
          'На gw: `sudo ip link set ens34 up`.'
        ]
      }
    ]
  });
})(window.NET);
