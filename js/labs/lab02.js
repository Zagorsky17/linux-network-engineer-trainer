/* Lab 02 — настройка статического IP через постоянную конфигурацию. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  NET.labs.register({
    id: 'lab02',
    title: 'Настрой статический IP',
    difficulty: 2,
    skills: ['networking', 'linux', 'automation', 'cli'],
    topology: 'campus',
    brief: 'Сервер srv1 перевели на статическую адресацию, но конфигурацию потеряли.\n' +
      'Интерфейс ens33 остался без адреса.\n\n' +
      'Настройте постоянно (так, чтобы пережило перезагрузку):\n' +
      '  адрес    192.168.10.25/24\n' +
      '  шлюз     192.168.10.1\n' +
      '  DNS      192.168.10.5, домен поиска corp.local',
    goal: 'Адрес, маршрут и DNS настроены через /etc/netplan и сохраняются после reboot.',

    setup: function (world, h) {
      h.writeNetplan('srv1', { network: { version: 2, renderer: 'networkd', ethernets: {} } });
      var m = world.get('srv1');
      m.net.flushAddrs('ens33');
      m.net.routes = m.net.routes.filter(function (r) { return r.dev !== 'ens33'; });
      m.setResolvConf([], []);
      m.net.setLink('ens33', { up: true });
      h.log('srv1', 'systemd-networkd', 'ens33: Link UP, no configuration found');
    },

    keySteps: [
      { id: 'inspect', title: 'Осмотреть текущее состояние (ip a / ip route)', match: /^ip\s+(-\w+\s+)*(a|addr|address|r|route)\b/ },
      { id: 'edit', title: 'Отредактировать /etc/netplan/*.yaml', match: /(nano|vi|vim|cat\s*>|sed|tee).*netplan/ },
      { id: 'apply', title: 'Применить конфигурацию (netplan apply)', match: /netplan\s+(apply|try)/ },
      { id: 'verify', title: 'Проверить результат (ping/dig)', match: /^(ping|dig|host|curl)\b/ }
    ],

    checks: [
      C.hasAddr('srv1', 'ens33', '192.168.10.25/24'),
      C.defaultVia('srv1', '192.168.10.1'),
      C.resolves('srv1', 'app1.corp.local', '192.168.10.30'),
      C.canPing('srv1', '8.8.8.8', 'Интернет'),
      C.survivesReboot('srv1', [
        C.hasAddr('srv1', 'ens33', '192.168.10.25/24'),
        C.defaultVia('srv1', '192.168.10.1')
      ])
    ],

    hints: [
      'Конфигурация Ubuntu живёт в /etc/netplan/*.yaml. Посмотрите файл: `sudo cat /etc/netplan/01-netcfg.yaml` (права 600 — нужен sudo). ' +
        'Редактор: `sudo nano /etc/netplan/01-netcfg.yaml`.',
      'Структура: network: → version: 2 → ethernets: → ens33: → addresses / routes / nameservers. ' +
        'Отступы только пробелами, адрес обязательно с /префиксом.',
      'Рабочий вариант:\n' +
        'network:\n  version: 2\n  renderer: networkd\n  ethernets:\n    ens33:\n' +
        '      addresses: [192.168.10.25/24]\n      routes:\n        - to: default\n          via: 192.168.10.1\n' +
        '      nameservers:\n        addresses: [192.168.10.5]\n        search: [corp.local]\n' +
        'Затем `sudo netplan apply` (или `sudo netplan try` — с автооткатом).'
    ],

    debrief: {
      why: 'Команды `ip addr add` и `ip route add` меняют состояние ядра здесь и сейчас — после перезагрузки они исчезают. ' +
        'Постоянная конфигурация в Ubuntu описывается декларативно в /etc/netplan/*.yaml и применяется бэкендом ' +
        '(systemd-networkd или NetworkManager). Поэтому проверка включает перезагрузку: работает только тот конфиг, ' +
        'который записан в файл.',
      commands: [
        ['sudo nano /etc/netplan/01-netcfg.yaml', 'правим декларативную конфигурацию'],
        ['sudo netplan generate', 'проверить синтаксис, не применяя'],
        ['sudo netplan try', 'применить с автоматическим откатом через 120 с — защита от потери доступа'],
        ['sudo netplan apply', 'применить'],
        ['ip -br a && ip route && resolvectl status', 'проверка результата']
      ],
      theory: 'netplan-basics',
      pitfalls: [
        'YAML не терпит табуляций — только пробелы.',
        'Адрес без /24 даёт ошибку «address is missing /prefixlength».',
        '`netplan apply` переконфигурирует интерфейс целиком: ручные ip-команды затираются.'
      ]
    },

    mutations: [
      {
        name: 'через NetworkManager',
        brief: 'На srv1 сеть переведена под управление NetworkManager, профиль удалён.\n' +
          'Настройте постоянно адрес 192.168.10.25/24, шлюз 192.168.10.1, DNS 192.168.10.5 — ' +
          'любым способом, который переживёт перезагрузку.',
        setup: function (world, h) {
          var m = world.get('srv1');
          h.writeNetplan('srv1', { network: { version: 2, renderer: 'NetworkManager', ethernets: {} } });
          m.services.define({ name: 'NetworkManager', description: 'Network Manager', exec: '/usr/sbin/NetworkManager --no-daemon', state: 'active' });
          m.net.flushAddrs('ens33');
          m.net.routes = m.net.routes.filter(function (r) { return r.dev !== 'ens33'; });
          m.setResolvConf([], []);
          m.net.setLink('ens33', { up: true });
        },
        hints: [
          '`nmcli dev status` покажет устройства, `nmcli con show` — профили. Профиля для ens33 нет.',
          'Создать профиль: `sudo nmcli con add con-name lan ifname ens33 type ethernet ipv4.method manual ipv4.addresses 192.168.10.25/24 ipv4.gateway 192.168.10.1 ipv4.dns 192.168.10.5`.',
          'После создания активируйте: `sudo nmcli con up lan`. Либо опишите то же самое в netplan с renderer: NetworkManager.'
        ]
      }
    ]
  });
})(window.NET);
