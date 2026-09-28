/* Lab 12 — неверная маска подсети: часть соседей «пропала», шлюз вне подсети. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var fixed = [
    C.hasAddr('srv1', 'ens33', '192.168.10.20/24'),
    C.canPing('srv1', '192.168.10.5', 'DNS-сервер ns1'),
    C.canPing('srv1', '8.8.8.8', 'Интернет'),
    C.resolves('srv1', 'www.example.com', '93.184.216.34'),
    C.survivesReboot('srv1', [
      C.hasAddr('srv1', 'ens33', '192.168.10.20/24'),
      C.defaultVia('srv1', '192.168.10.1')
    ])
  ];

  var netplanFix = "printf 'network:\\n  version: 2\\n  renderer: networkd\\n  ethernets:\\n    ens33:\\n" +
    "      addresses: [192.168.10.20/24]\\n      routes:\\n        - to: default\\n          via: 192.168.10.1\\n" +
    "      nameservers:\\n        addresses: [192.168.10.5, 8.8.8.8]\\n        search: [corp.local]\\n' " +
    '| sudo tee /etc/netplan/01-netcfg.yaml';

  NET.labs.register({
    id: 'lab12',
    title: 'Половина сети не видна: маска подсети',
    difficulty: 2,
    skills: ['networking', 'routing', 'automation', 'troubleshooting'],
    topology: 'campus',
    brief: 'После переустановки srv1 странная картина:\n' +
      '  • app1 (192.168.10.30) пингуется;\n' +
      '  • ns1 (192.168.10.5) и шлюз 192.168.10.1 — «Network is unreachable»;\n' +
      '  • интернета и DNS нет.\n\n' +
      'Все хосты стоят в одном коммутаторе, кабели проверены.\n' +
      'План адресации: сеть 192.168.10.0/24, srv1 = 192.168.10.20, шлюз .1, DNS .5.\n' +
      'Найдите причину и исправьте постоянно.',
    goal: 'srv1 видит всю подсеть 192.168.10.0/24, выходит в интернет, настройка переживает reboot.',

    setup: function (world, h) {
      h.netplanPatch('srv1', { addresses: ['192.168.10.20/28'] });
      h.log('srv1', 'systemd-networkd', 'ens33: Could not set route: Nexthop has invalid gateway', 'warning');
    },

    keySteps: [
      { id: 'addr', title: 'Посмотреть адрес и префикс (ip -br a)', match: /^ip\s+(-\w+\s+)*(a|addr|address)\b/ },
      { id: 'route', title: 'Изучить таблицу маршрутов (ip route)', match: /^ip\s+(-\w+\s+)*(r|route)\b/ },
      { id: 'ping', title: 'Сравнить доступность соседей (ping)', match: /^ping\b.*192\.168\.10\./ },
      { id: 'calc', title: 'Посчитать границы подсети (ipcalc)', match: /^ipcalc\b/ },
      { id: 'netplan', title: 'Исправить netplan и применить', match: /netplan\s+(apply|try)/ }
    ],

    checks: fixed,

    solution: [
      'ip -br a',
      'ip route',
      'ping -c1 192.168.10.30',
      'ping -c1 192.168.10.5',
      'ipcalc 192.168.10.20/28',
      'sudo cat /etc/netplan/01-netcfg.yaml',
      netplanFix,
      'sudo netplan apply',
      'ip route',
      'ping -c1 8.8.8.8'
    ],

    hints: [
      'Посмотрите на адрес внимательно: `ip -br a`. Что стоит после косой черты? А что в `ip route` — есть ли там default?',
      'Префикс /28 — это подсеть из 16 адресов: 192.168.10.16–31 (проверьте `ipcalc 192.168.10.20/28`). ' +
        'app1 (.30) в неё попадает, а шлюз .1 и DNS .5 — нет. Поэтому и маршрут через шлюз не установился.',
      'Исправьте в /etc/netplan/01-netcfg.yaml адрес на 192.168.10.20/24 (`sudo nano /etc/netplan/01-netcfg.yaml`) ' +
        'и выполните `sudo netplan apply`.'
    ],

    debrief: {
      why: 'Маска определяет, какие адреса хост считает «своими», то есть доступными напрямую через ARP. ' +
        'С /28 srv1 решил, что его сеть — 192.168.10.16/28, а всё остальное нужно слать через шлюз. ' +
        'Но сам шлюз 192.168.10.1 оказался вне этой подсети, поэтому маршрут по умолчанию ядро отвергло ' +
        '(«Nexthop has invalid gateway»). Итог — соседи из «своей» шестнадцатки доступны, остальная сеть ' +
        'и интернет дают «Network is unreachable», хотя физически все в одном коммутаторе.',
      commands: [
        ['ip -br a', 'адрес вместе с префиксом — первая вещь, на которую смотреть'],
        ['ip route', 'connected-маршрут 192.168.10.16/28 и отсутствие default выдают неверную маску'],
        ['ipcalc 192.168.10.20/28', 'границы подсети: какие адреса «свои»'],
        ['ping -c1 192.168.10.30 && ping -c1 192.168.10.5', 'один сосед доступен, другой — нет: классика неверной маски'],
        ['sudo netplan apply', 'применить исправленный префикс']
      ],
      theory: 'subnet-mask',
      pitfalls: [
        'Проверять «кабель и коммутатор», когда ошибка — «Network is unreachable»: её выдаёт локальное ядро.',
        'Добавлять маршрут до шлюза вручную (ip route add 192.168.10.1 dev ens33) вместо исправления маски — ' +
          'сеть заработает частично, а после перезагрузки всё вернётся.',
        'Путать префикс /28 и /24 при копировании адреса из соседнего конфига.'
      ]
    },

    mutations: [
      {
        name: 'опечатка в адресе',
        brief: 'srv1 после правки конфигурации «выпал» из сети полностью:\n' +
          'не пингуется ни шлюз, ни соседи, ни интернет. Интерфейс поднят, адрес есть.\n' +
          'План адресации: srv1 = 192.168.10.20/24, шлюз 192.168.10.1, DNS 192.168.10.5.',
        setup: function (world, h) {
          h.netplanPatch('srv1', { addresses: ['192.168.100.20/24'] });
        },
        solution: [
          'ip -br a',
          'ip route',
          'ping -c1 192.168.10.1',
          'sudo cat /etc/netplan/01-netcfg.yaml',
          netplanFix,
          'sudo netplan apply',
          'ping -c1 8.8.8.8'
        ],
        hints: [
          'Сравните адрес из `ip -br a` с планом адресации цифра за цифрой.',
          '192.168.100.20 — это другая сеть: шлюз 192.168.10.1 в неё не входит, поэтому default route не установлен.',
          'Исправьте адрес в /etc/netplan/01-netcfg.yaml на 192.168.10.20/24 и выполните `sudo netplan apply`.'
        ],
        debrief: {
          why: 'Опечатка перенесла srv1 в сеть 192.168.100.0/24. Ни шлюз, ни соседи в неё не входят, ' +
            'маршрут по умолчанию ядро отвергло, и любая попытка связи заканчивалась «Network is unreachable». ' +
            'Симптом «сломалось всё сразу» при поднятом интерфейсе почти всегда указывает на адресацию.',
          commands: [
            ['ip -br a', 'увидеть фактический адрес'],
            ['ip route', 'connected-сеть 192.168.100.0/24 и отсутствие default'],
            ['sudo netplan apply', 'применить исправленный адрес']
          ],
          theory: 'subnet-mask'
        }
      }
    ]
  });
})(window.NET);
