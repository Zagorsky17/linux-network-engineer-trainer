/* Lab 13 — сервис слушает не тот адрес: локально работает, клиентам refused. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var SITE = '/etc/nginx/sites-available/default';

  NET.labs.register({
    id: 'lab13',
    title: 'Локально работает, снаружи нет: адрес прослушивания',
    difficulty: 3,
    skills: ['services', 'tcpip', 'troubleshooting', 'linux'],
    topology: 'campus',
    brief: 'Разработчик «усилил безопасность» веб-сервера на srv1 и ушёл в отпуск.\n' +
      'Теперь на самом srv1 `curl -k https://127.0.0.1` отдаёт страницу,\n' +
      'а клиенты с app1 получают «Connection refused» на портах 80 и 443.\n' +
      'Firewall на srv1 выключен.\n\n' +
      'Найдите, что изменилось, и верните доступ клиентам.',
    goal: 'С app1 открываются порты 80 и 443 на srv1; исправление переживает перезагрузку.',

    setup: function (world, h) {
      h.editFile('srv1', SITE, 'listen 80 default_server;', 'listen 127.0.0.1:80 default_server;');
      h.editFile('srv1', SITE, 'listen 443 ssl default_server;', 'listen 127.0.0.1:443 ssl default_server;');
      world.get('srv1').services.restart('nginx');
    },

    keySteps: [
      { id: 'client', title: 'Воспроизвести проблему с клиента', match: /^(connect\s+app1|nc|curl|telnet)\b/ },
      { id: 'local', title: 'Проверить сервис локально', match: /^(curl|nc|wget)\b.*(127\.0\.0\.1|localhost)/ },
      { id: 'listen', title: 'Посмотреть адреса прослушивания (ss -tlnp)', match: /^(sudo\s+)?(ss|netstat)\b/ },
      { id: 'config', title: 'Найти директиву listen в конфигурации', match: /(grep|cat|less|nano|vi|sed).*nginx/ },
      { id: 'test', title: 'Проверить конфигурацию перед перезапуском (nginx -t)', match: /nginx\s+-t/ }
    ],

    checks: [
      C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента'),
      C.tcpOpen('app1', '192.168.10.20', 80, 'HTTP с клиента'),
      C.survivesReboot('srv1', [
        C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента')
      ])
    ],

    solution: [
      'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1',
      'curl -k -I https://127.0.0.1',
      'sudo ss -tlnp',
      'grep -rn listen /etc/nginx/sites-enabled/',
      "sudo sed -i 's/listen 127.0.0.1:/listen /' /etc/nginx/sites-available/default",
      'sudo nginx -t',
      'sudo systemctl reload nginx',
      'sudo ss -tlnp'
    ],

    hints: [
      'Сравните, как видят сервис сервер и клиент. На srv1: `sudo ss -tlnp` — посмотрите колонку Local Address у nginx.',
      'nginx слушает 127.0.0.1:80 и 127.0.0.1:443 — только loopback. Пакеты клиента приходят на 192.168.10.20, ' +
        'а там порт никто не слушает, отсюда RST. Ищите директиву listen: `grep -rn listen /etc/nginx/sites-enabled/`.',
      "Уберите адрес из директив: `sudo sed -i 's/listen 127.0.0.1:/listen /' /etc/nginx/sites-available/default`, " +
        'проверьте `sudo nginx -t` и примените `sudo systemctl reload nginx`.'
    ],

    debrief: {
      why: 'Сокет привязывается к адресу. 127.0.0.1 — это loopback: соединение к нему возможно только ' +
        'с самой машины. Пакеты с app1 приходят на 192.168.10.20:443, где сокета нет, и ядро отвечает RST — ' +
        'клиент видит «Connection refused». Firewall тут ни при чём: при фильтрации DROP был бы таймаут. ' +
        'Директива listen 127.0.0.1:443 уместна за обратным прокси на той же машине, но не для публичного сервиса.',
      commands: [
        ['sudo ss -tlnp', 'Local Address 127.0.0.1:443 вместо 0.0.0.0:443 — главная улика'],
        ['curl -k -I https://127.0.0.1', 'локальная проверка проходит — сервис жив'],
        ['nc -zv 192.168.10.20 443 (с app1)', 'refused — хост доступен, порт на этом адресе не слушается'],
        ['grep -rn listen /etc/nginx/sites-enabled/', 'найти, откуда взялся адрес'],
        ['sudo nginx -t && sudo systemctl reload nginx', 'проверить и применить конфигурацию без простоя']
      ],
      theory: 'listen-address',
      pitfalls: [
        'Считать успешный curl на 127.0.0.1 доказательством, что сервис доступен клиентам.',
        'Открывать порты в firewall, когда клиент получает refused, а не таймаут.',
        'Перезапускать сервис без `nginx -t`: ошибка в конфигурации уронит его совсем.'
      ]
    },

    mutations: [
      {
        name: 'SSH только на loopback',
        brief: 'Администраторы не могут зайти на srv1 по SSH с app1: «Connection refused».\n' +
          'Служба ssh при этом активна, `systemctl status ssh` — active (running),\n' +
          'и с самого srv1 `nc -zv 127.0.0.1 22` проходит. Верните доступ.',
        setup: function (world, h) {
          h.editFile('srv1', '/etc/ssh/sshd_config', '#ListenAddress 0.0.0.0', 'ListenAddress 127.0.0.1');
          world.get('srv1').services.restart('ssh');
        },
        checks: [
          C.tcpOpen('app1', '192.168.10.20', 22, 'SSH с клиента'),
          C.survivesReboot('srv1', [C.tcpOpen('app1', '192.168.10.20', 22, 'SSH с клиента')])
        ],
        keySteps: [
          { id: 'client', title: 'Воспроизвести проблему с клиента', match: /^(connect\s+app1|nc|ssh|telnet)\b/ },
          { id: 'service', title: 'Проверить состояние sshd', match: /systemctl\s+(status|is-active)/ },
          { id: 'listen', title: 'Посмотреть адреса прослушивания (ss -tlnp)', match: /^(sudo\s+)?(ss|netstat)\b/ },
          { id: 'config', title: 'Найти ListenAddress в sshd_config', match: /(grep|cat|less|nano|vi|sed).*sshd_config/ }
        ],
        solution: [
          'connect app1', 'nc -zv 192.168.10.20 22', 'connect srv1',
          'systemctl status ssh',
          'sudo ss -tlnp',
          'sudo grep -n ListenAddress /etc/ssh/sshd_config',
          "sudo sed -i 's/^ListenAddress 127.0.0.1/#ListenAddress 0.0.0.0/' /etc/ssh/sshd_config",
          'sudo sshd -t',
          'sudo systemctl restart ssh'
        ],
        hints: [
          '`sudo ss -tlnp | grep :22` — на каком адресе слушает sshd?',
          'sshd принимает соединения только на 127.0.0.1. За это отвечает директива ListenAddress в /etc/ssh/sshd_config.',
          "Закомментируйте её: `sudo sed -i 's/^ListenAddress 127.0.0.1/#ListenAddress 0.0.0.0/' /etc/ssh/sshd_config`, " +
            'затем `sudo sshd -t` и `sudo systemctl restart ssh`.'
        ],
        debrief: {
          why: 'ListenAddress 127.0.0.1 привязал sshd к loopback. Служба работала и отвечала локально, ' +
            'но на адресе 192.168.10.20 порт 22 никто не слушал — клиенты получали RST (refused). ' +
            'Изменения sshd_config вступают в силу только после перезапуска службы.',
          commands: [
            ['sudo ss -tlnp | grep :22', 'адрес, к которому привязан sshd'],
            ['sudo grep -n ListenAddress /etc/ssh/sshd_config', 'источник ограничения'],
            ['sudo sshd -t', 'проверка синтаксиса перед перезапуском'],
            ['sudo systemctl restart ssh', 'применить']
          ],
          theory: 'listen-address'
        }
      },
      {
        name: 'сервис на нестандартном порту',
        brief: 'После обновления конфигурации клиенты с app1 получают «Connection refused» на https://srv1.\n' +
          'nginx на srv1 запущен и ошибок в журнале нет. Firewall выключен. Найдите причину.',
        setup: function (world, h) {
          h.editFile('srv1', SITE, 'listen 443 ssl default_server;', 'listen 8443 ssl default_server;');
          world.get('srv1').services.restart('nginx');
        },
        checks: [
          C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента'),
          C.survivesReboot('srv1', [C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента')])
        ],
        solution: [
          'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1',
          'sudo ss -tlnp',
          'grep -rn listen /etc/nginx/sites-enabled/',
          "sudo sed -i 's/listen 8443 ssl/listen 443 ssl/' /etc/nginx/sites-available/default",
          'sudo nginx -t',
          'sudo systemctl reload nginx'
        ],
        hints: [
          '`sudo ss -tlnp` — какие порты слушает nginx на самом деле?',
          'Вместо 443 слушается 8443: директива listen в /etc/nginx/sites-available/default изменена.',
          "`sudo sed -i 's/listen 8443 ssl/listen 443 ssl/' /etc/nginx/sites-available/default`, затем `sudo nginx -t` и `sudo systemctl reload nginx`."
        ],
        debrief: {
          why: 'Сервис был жив, но слушал 8443. На 443 сокета не было, и ядро отвечало RST — «Connection refused». ' +
            'ss -tlnp сразу показывает фактические порты процесса, не нужно гадать по конфигурации.',
          commands: [
            ['sudo ss -tlnp', 'фактические порты и процессы'],
            ['grep -rn listen /etc/nginx/sites-enabled/', 'откуда взялся порт'],
            ['sudo nginx -t && sudo systemctl reload nginx', 'проверить и применить']
          ],
          theory: 'listen-address'
        }
      }
    ]
  });
})(window.NET);
