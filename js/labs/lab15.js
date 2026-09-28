/* Lab 15 — комплексный инцидент после миграции: адресация, имена, сервис, транзит. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var SITE = '/etc/nginx/sites-available/default';
  var NETPLAN_FIX = "printf 'network:\\n  version: 2\\n  renderer: networkd\\n  ethernets:\\n    ens33:\\n" +
    "      addresses: [192.168.10.20/24]\\n      routes:\\n        - to: default\\n          via: 192.168.10.1\\n" +
    "      nameservers:\\n        addresses: [192.168.10.5, 8.8.8.8]\\n        search: [corp.local]\\n' " +
    '| sudo tee /etc/netplan/01-netcfg.yaml';

  NET.labs.register({
    id: 'lab15',
    title: 'Комплексный incident: после миграции',
    difficulty: 5,
    skills: ['troubleshooting', 'networking', 'routing', 'dns', 'services', 'firewall'],
    topology: 'campus',
    brief: 'Выходные ушли на миграцию: srv1 переустановлен из «золотого образа»,\n' +
      'на шлюзе gw прогнали скрипт hardening. В понедельник жалобы:\n' +
      '  • у app1 и у srv1 нет интернета;\n' +
      '  • srv1 не видит DNS-сервер ns1 и шлюз;\n' +
      '  • со srv1 не открывается портал app1.corp.local;\n' +
      '  • клиенты не могут открыть сайт на srv1 (80/443).\n\n' +
      'Неисправностей несколько, они на разных хостах и независимы.\n' +
      'Доступ: srv1 (текущий), app1 и gw через `connect`.\n' +
      'Всё исправленное должно пережить перезагрузку.',
    goal: 'Интернет у LAN, DNS и портал с srv1, сайт srv1 для клиентов; srv1 и gw переживают reboot.',

    setup: function (world, h) {
      /* 1. «золотой образ» с маской от другой площадки */
      h.netplanPatch('srv1', { addresses: ['192.168.10.20/28'] });
      /* 2. забытая запись из образа */
      h.appendFile('srv1', '/etc/hosts', '\n# golden image\n192.168.10.31\tapp1.corp.local app1');
      /* 3. веб-сервер в образе привязан к loopback */
      h.editFile('srv1', SITE, 'listen 80 default_server;', 'listen 127.0.0.1:80 default_server;');
      h.editFile('srv1', SITE, 'listen 443 ssl default_server;', 'listen 127.0.0.1:443 ssl default_server;');
      world.get('srv1').services.restart('nginx');
      /* 4. hardening выключил пересылку на шлюзе */
      h.writeFile('gw', '/etc/sysctl.d/60-hardening.conf',
        '# hardening: disable routing\nnet.ipv4.ip_forward = 0\n');
      h.sysctl('gw', 'net.ipv4.ip_forward', 0);
    },

    keySteps: [
      { id: 'addr', title: 'Проверить адрес и маску srv1', match: /ip\s+(-\w+\s+)*(a|addr)\b/ },
      { id: 'route', title: 'Проверить маршруты', match: /ip\s+(-\w+\s+)*(r|route)\b/ },
      { id: 'trace', title: 'Локализовать обрыв пути (traceroute) с app1', match: /^(traceroute|tracepath|mtr)\b/ },
      { id: 'names', title: 'Сравнить DNS и системный резолвер (dig / getent)', match: /^getent\b/ },
      { id: 'listen', title: 'Проверить адреса прослушивания (ss -tlnp)', match: /^(sudo\s+)?(ss|netstat)\b/ },
      { id: 'gw', title: 'Проверить пересылку на шлюзе (sysctl)', match: /sysctl/ },
      { id: 'client', title: 'Проверить со стороны клиента', match: /^(connect\s+app1|nc|curl)\b/ }
    ],

    checks: [
      C.canPing('app1', '8.8.8.8', 'Интернет у app1'),
      C.canPing('srv1', '8.8.8.8', 'Интернет у srv1'),
      C.resolves('srv1', 'www.example.com', '93.184.216.34'),
      C.tcpOpenByName('srv1', 'app1.corp.local', 80, 'Портал с srv1 по имени'),
      C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS srv1 с клиента'),
      C.survivesReboot('srv1', [
        C.hasAddr('srv1', 'ens33', '192.168.10.20/24'),
        C.defaultVia('srv1', '192.168.10.1'),
        C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS srv1 с клиента')
      ]),
      C.survivesReboot('gw', [C.canPing('app1', '8.8.8.8', 'Интернет у app1')])
    ],

    solution: [
      /* масштаб: app1 тоже без интернета — значит, есть общая причина */
      'connect app1', 'ping -c1 192.168.10.1', 'ping -c1 8.8.8.8', 'traceroute -n -m 3 8.8.8.8',
      'nc -zv 192.168.10.20 443',
      /* шлюз */
      'connect gw', 'ping -c1 8.8.8.8', 'sysctl net.ipv4.ip_forward',
      'grep -rn ip_forward /etc/sysctl.conf /etc/sysctl.d/',
      "sudo sed -i 's/^net.ipv4.ip_forward = 0/net.ipv4.ip_forward = 1/' /etc/sysctl.d/60-hardening.conf",
      'sudo sysctl --system',
      /* srv1: адресация */
      'connect srv1', 'ip -br a', 'ip route', 'ipcalc 192.168.10.20/28',
      NETPLAN_FIX, 'sudo netplan apply', 'ping -c1 8.8.8.8',
      /* srv1: имена */
      'dig +short app1.corp.local', 'getent hosts app1.corp.local',
      "sudo sed -i '/192.168.10.31/d' /etc/hosts",
      /* srv1: сервис */
      'sudo ss -tlnp', 'grep -rn listen /etc/nginx/sites-enabled/',
      "sudo sed -i 's/listen 127.0.0.1:/listen /' /etc/nginx/sites-available/default",
      'sudo nginx -t', 'sudo systemctl reload nginx',
      'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1'
    ],

    hints: [
      'Начните с масштаба: у app1 тоже нет интернета, а его никто не трогал. Значит, одна причина общая — ' +
        'и она на шлюзе. Остальные жалобы касаются только srv1: пройдите его снизу вверх — адрес и маска, ' +
        'маршрут, имена (dig против getent), адреса прослушивания (ss -tlnp).',
      'Четыре неисправности: (1) на gw `sysctl net.ipv4.ip_forward` = 0; (2) на srv1 маска /28 вместо /24, ' +
        'поэтому шлюз и ns1 вне подсети; (3) в /etc/hosts srv1 устаревшая запись app1.corp.local; ' +
        '(4) nginx на srv1 слушает только 127.0.0.1.',
      'Исправление: на gw поправить /etc/sysctl.d/60-hardening.conf (ip_forward = 1) и `sudo sysctl --system`; ' +
        'на srv1 — адрес 192.168.10.20/24 в netplan и `sudo netplan apply`; ' +
        "`sudo sed -i '/192.168.10.31/d' /etc/hosts`; " +
        "`sudo sed -i 's/listen 127.0.0.1:/listen /' /etc/nginx/sites-available/default` и `sudo systemctl reload nginx`."
    ],

    debrief: {
      why: 'Четыре независимые неисправности на двух хостах. Выключенный ip_forward на gw лишил интернета всю LAN — ' +
        'это видно по тому, что пострадал и нетронутый app1. Маска /28 на srv1 вывела из «своей» подсети шлюз и ns1: ' +
        'маршрут по умолчанию не установился, DNS пропал. Запись в /etc/hosts перекрывала верный ответ DNS ' +
        'для портала. nginx, привязанный к 127.0.0.1, отвечал только локально, клиенты получали refused. ' +
        'Ключ к быстрому разбору — сначала масштаб (кого затронуло?), потом слои снизу вверх на каждом хосте ' +
        'и проверка каждой жалобы отдельно после каждого исправления.',
      commands: [
        ['connect app1 && ping -c1 8.8.8.8', 'масштаб: общая ли это проблема'],
        ['traceroute -n -m 3 8.8.8.8', 'звёзды на первом хопе при живом шлюзе — шлюз не пересылает'],
        ['sysctl net.ipv4.ip_forward && grep -rn ip_forward /etc/sysctl.d/', 'значение и его источник'],
        ['ip -br a && ipcalc 192.168.10.20/28', 'неверная маска и границы подсети'],
        ['getent hosts app1.corp.local', 'имя глазами приложения, с учётом /etc/hosts'],
        ['sudo ss -tlnp', 'на каком адресе слушает сервис']
      ],
      theory: 'incident-scope',
      pitfalls: [
        'Начинать с srv1 и не заметить, что app1 тоже без интернета, — общая причина на шлюзе.',
        'Починив маску, считать, что всё решено: портал и сайт сломаны по другим причинам.',
        'Исправлять ip_forward через `sysctl -w` без правки файла — после перезагрузки шлюза всё вернётся.'
      ]
    },

    mutations: [
      {
        name: 'другой набор неисправностей',
        brief: 'Вторая волна жалоб после миграции:\n' +
          '  • со srv1 вместо www.example.com открывается «Welcome to nginx!»;\n' +
          '  • администраторы не заходят на srv1 по SSH с app1;\n' +
          '  • клиенты не открывают https://srv1 — «Connection refused»;\n' +
          '  • из LAN недоступен филиал 10.20.0.0/16.\n\n' +
          'Доступ: srv1, app1 и gw через `connect`. Найдите и устраните все причины.',
        setup: function (world, h) {
          var srv = world.get('srv1');
          h.appendFile('srv1', '/etc/hosts', '\n# golden image\n127.0.0.1\twww.example.com');
          h.editFile('srv1', '/etc/ssh/sshd_config', '#ListenAddress 0.0.0.0', 'ListenAddress 127.0.0.1');
          srv.services.restart('ssh');
          h.editFile('srv1', SITE, 'listen 443 ssl default_server;', 'listen 8443 ssl default_server;');
          srv.services.restart('nginx');
          world.get('gw').fw.addRule('FORWARD', {
            src: '192.168.10.0/24', dst: '10.20.0.0/16', target: 'DROP', comment: 'hardening'
          });
        },
        checks: [
          C.resolves('srv1', 'www.example.com', '93.184.216.34'),
          C.tcpOpen('app1', '192.168.10.20', 22, 'SSH с клиента'),
          C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента'),
          C.canPing('srv1', '10.20.5.10', 'Филиал из LAN'),
          C.survivesReboot('srv1', [
            C.tcpOpen('app1', '192.168.10.20', 22, 'SSH с клиента'),
            C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента')
          ])
        ],
        solution: [
          'getent hosts www.example.com', "sudo sed -i '/www.example.com/d' /etc/hosts",
          'sudo ss -tlnp',
          "sudo sed -i 's/^ListenAddress 127.0.0.1/#ListenAddress 0.0.0.0/' /etc/ssh/sshd_config",
          'sudo sshd -t', 'sudo systemctl restart ssh',
          "sudo sed -i 's/listen 8443 ssl/listen 443 ssl/' /etc/nginx/sites-available/default",
          'sudo nginx -t', 'sudo systemctl reload nginx',
          'traceroute -n -m 3 10.20.5.10',
          'connect gw', 'sudo iptables -L FORWARD -n --line-numbers',
          'sudo iptables -D FORWARD 1',
          'connect srv1', 'ping -c1 10.20.5.10'
        ],
        hints: [
          'Четыре жалобы — четыре проверки. Имена: `getent hosts www.example.com`. Сервисы: `sudo ss -tlnp`. ' +
            'Филиал: `traceroute -n 10.20.5.10`, затем цепочка FORWARD на gw.',
          'www.example.com подменён на 127.0.0.1 в /etc/hosts; sshd слушает только 127.0.0.1; nginx слушает 8443 ' +
            'вместо 443; на gw правило DROP в FORWARD для 192.168.10.0/24 → 10.20.0.0/16.',
          "Исправление: `sudo sed -i '/www.example.com/d' /etc/hosts`; закомментировать ListenAddress в sshd_config " +
            'и `sudo systemctl restart ssh`; вернуть `listen 443 ssl` и `sudo systemctl reload nginx`; ' +
            'на gw `sudo iptables -D FORWARD 1`.'
        ],
        debrief: {
          why: 'Снова независимые причины: подмена имени в /etc/hosts, два сервиса с неверной привязкой ' +
            '(адрес у sshd, порт у nginx) и фильтр транзита на шлюзе. refused на SSH и HTTPS указывал на сокеты, ' +
            'а не на фильтр; обрыв сразу за шлюзом при работающем интернете — на правило FORWARD.',
          commands: [
            ['getent hosts www.example.com', 'подмена имени'],
            ['sudo ss -tlnp', 'адреса и порты sshd и nginx'],
            ['traceroute -n -m 3 10.20.5.10', 'обрыв за шлюзом'],
            ['sudo iptables -L FORWARD -n --line-numbers', 'фильтр транзита на gw']
          ],
          theory: 'incident-scope'
        }
      }
    ]
  });
})(window.NET);
