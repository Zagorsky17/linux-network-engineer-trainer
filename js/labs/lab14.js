/* Lab 14 — шлюз перестал маршрутизировать: ip_forward и цепочка FORWARD. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var DIAG_LAN = [
    'ping -c1 192.168.10.1',
    'ping -c1 8.8.8.8',
    'traceroute -n 8.8.8.8',
    'connect gw',
    'ping -c1 8.8.8.8'
  ];

  NET.labs.register({
    id: 'lab14',
    title: 'Шлюз не пропускает транзит: ip_forward и FORWARD',
    difficulty: 4,
    skills: ['routing', 'firewall', 'troubleshooting', 'linux'],
    topology: 'campus',
    brief: 'Вчера шлюз gw «усилили» по чек-листу безопасности. Сегодня:\n' +
      '  • у всей LAN нет интернета, а внешние имена не разрешаются;\n' +
      '  • сеть филиала 10.20.0.0/16 недоступна;\n' +
      '  • сам gw при этом спокойно пингует 8.8.8.8 и филиал.\n\n' +
      'Доступ к шлюзу: `connect gw`. Найдите, что сломал «hardening»,\n' +
      'и почините так, чтобы шлюз работал и после перезагрузки.',
    goal: 'LAN выходит в интернет и в филиал через gw; исправление на gw переживает reboot.',

    setup: function (world, h) {
      h.writeFile('gw', '/etc/sysctl.d/99-hardening.conf', [
        '# CIS benchmark 3.1.1 — host is not a router',
        'net.ipv4.ip_forward = 0',
        'net.ipv4.conf.all.send_redirects = 0',
        ''
      ].join('\n'));
      h.sysctl('gw', 'net.ipv4.ip_forward', 0);
      h.log('gw', 'systemd-sysctl', 'Applying /etc/sysctl.d/99-hardening.conf');
    },

    keySteps: [
      { id: 'gw', title: 'Убедиться, что шлюз доступен из LAN', match: /^ping\b.*192\.168\.10\.1\b/ },
      { id: 'trace', title: 'Найти место обрыва (traceroute)', match: /^(traceroute|tracepath|mtr)\b/ },
      { id: 'login', title: 'Проверить с самого шлюза (connect gw)', match: /^connect\s+gw\b/ },
      { id: 'sysctl', title: 'Проверить net.ipv4.ip_forward', match: /(sysctl.*ip_forward|\/proc\/sys\/net\/ipv4\/ip_forward)/ },
      { id: 'persist', title: 'Найти, откуда берётся значение (/etc/sysctl.d)', match: /(grep|cat|ls|less).*sysctl/ }
    ],

    checks: [
      C.canPing('srv1', '8.8.8.8', 'Интернет из LAN'),
      C.canPing('srv1', '10.20.5.10', 'Филиал из LAN'),
      C.resolves('srv1', 'www.example.com', '93.184.216.34'),
      C.survivesReboot('gw', [
        C.canPing('srv1', '8.8.8.8', 'Интернет из LAN'),
        C.canPing('srv1', '10.20.5.10', 'Филиал из LAN')
      ])
    ],

    solution: DIAG_LAN.concat([
      'sysctl net.ipv4.ip_forward',
      'grep -rn ip_forward /etc/sysctl.conf /etc/sysctl.d/',
      "sudo sed -i 's/^net.ipv4.ip_forward = 0/net.ipv4.ip_forward = 1/' /etc/sysctl.d/99-hardening.conf",
      'sudo sysctl --system',
      'connect srv1',
      'ping -c1 8.8.8.8'
    ]),

    hints: [
      'С srv1: шлюз пингуется, а 8.8.8.8 — нет. `traceroute -n 8.8.8.8` — ответил ли хотя бы первый хоп? ' +
        'Затем зайдите на шлюз (`connect gw`) и убедитесь, что оттуда интернет есть.',
      'Сам gw в интернет ходит, а чужие пакеты дальше не передаёт — и даже не отвечает на traceroute. ' +
        'Так ведёт себя Linux, у которого выключена пересылка: `sysctl net.ipv4.ip_forward`.',
      'На gw: значение 0 задано в /etc/sysctl.d/99-hardening.conf (`grep -rn ip_forward /etc/sysctl.conf /etc/sysctl.d/`). ' +
        "Исправьте файл: `sudo sed -i 's/^net.ipv4.ip_forward = 0/net.ipv4.ip_forward = 1/' /etc/sysctl.d/99-hardening.conf` " +
        'и примените `sudo sysctl --system`. Одного `sysctl -w` мало — после перезагрузки файл вернёт 0.'
    ],

    debrief: {
      why: 'Маршрутизатор на Linux — это обычный хост с включённой пересылкой пакетов (net.ipv4.ip_forward = 1). ' +
        'Правило чек-листа «хост не маршрутизатор» выключило её на шлюзе. Собственный трафик gw продолжал ходить, ' +
        'а транзитные пакеты от LAN ядро молча отбрасывало — даже не уменьшая TTL, поэтому traceroute ' +
        'не получал ответа уже от первого хопа. Внутренний DNS тоже перестал разрешать внешние имена: ' +
        'ns1 пересылает запросы на 8.8.8.8 через тот же шлюз. Значение хранилось в /etc/sysctl.d, ' +
        'и исправлять нужно именно файл, иначе проблема вернётся после перезагрузки.',
      commands: [
        ['traceroute -n 8.8.8.8', 'звёздочки уже на первом хопе при живом шлюзе — шлюз не пересылает'],
        ['connect gw && ping -c1 8.8.8.8', 'сам шлюз с интернетом — проблема именно в транзите'],
        ['sysctl net.ipv4.ip_forward', 'текущее значение параметра ядра'],
        ['grep -rn ip_forward /etc/sysctl.conf /etc/sysctl.d/', 'откуда значение возьмётся при загрузке'],
        ['sudo sysctl --system', 'перечитать все файлы sysctl без перезагрузки']
      ],
      theory: 'ip-forwarding',
      pitfalls: [
        '`sudo sysctl -w net.ipv4.ip_forward=1` чинит до первой перезагрузки: файл в /etc/sysctl.d вернёт 0.',
        'Искать проблему на клиентах: их маршруты и адреса в порядке, ломается транзит на шлюзе.',
        'Применять чек-листы hardening к маршрутизаторам без исключений для их роли.'
      ]
    },

    mutations: [
      {
        name: 'политика FORWARD DROP',
        brief: 'После установки на шлюз gw контейнерной платформы у всей LAN пропал интернет,\n' +
          'и филиал 10.20.0.0/16 недоступен. Сам gw в интернет ходит.\n' +
          'Доступ к шлюзу: `connect gw`. Восстановите транзит.',
        setup: function (world, h) {
          world.get('gw').fw.policy.FORWARD = 'DROP';
          h.log('gw', 'dockerd', 'Setting FORWARD chain policy to DROP');
        },
        checks: [
          C.canPing('srv1', '8.8.8.8', 'Интернет из LAN'),
          C.canPing('srv1', '10.20.5.10', 'Филиал из LAN')
        ],
        solution: DIAG_LAN.concat([
          'sysctl net.ipv4.ip_forward',
          'sudo iptables -L FORWARD -n -v',
          'sudo iptables -P FORWARD ACCEPT',
          'connect srv1',
          'ping -c1 8.8.8.8'
        ]),
        hints: [
          '`traceroute -n 8.8.8.8` с srv1: первый хоп (шлюз) теперь отвечает, а дальше — звёздочки. Значит, TTL на gw ' +
            'уменьшается, пересылка включена, но пакет дальше не уходит.',
          'На gw: `sysctl net.ipv4.ip_forward` = 1. Транзит фильтрует netfilter — посмотрите цепочку FORWARD: ' +
            '`sudo iptables -L FORWARD -n -v`.',
          'Политика цепочки FORWARD — DROP, разрешающих правил нет. `sudo iptables -P FORWARD ACCEPT` ' +
            '(или добавьте точечные ACCEPT для LAN).'
        ],
        debrief: {
          why: 'Контейнерные платформы (Docker и др.) при старте ставят политику цепочки FORWARD в DROP. ' +
            'На обычном сервере это незаметно, а на шлюзе режет весь транзит. В отличие от выключенного ip_forward, ' +
            'шлюз успевает уменьшить TTL и отвечает на traceroute — поэтому первый хоп виден, а дальше тишина.',
          commands: [
            ['traceroute -n 8.8.8.8', 'первый хоп отвечает, дальше нет — транзит фильтруется на шлюзе'],
            ['sudo iptables -L FORWARD -n -v', 'policy DROP и ни одного разрешающего правила'],
            ['sudo iptables -P FORWARD ACCEPT', 'вернуть пропуск транзита']
          ],
          theory: 'ip-forwarding'
        }
      },
      {
        name: 'правило FORWARD режет филиал',
        brief: 'Из LAN перестала открываться сеть филиала 10.20.0.0/16. Интернет из LAN работает.\n' +
          'Маршрут до филиала на шлюзе на месте, с самого gw филиал пингуется.\n' +
          'Доступ к шлюзу: `connect gw`. Найдите причину.',
        setup: function (world, h) {
          world.get('gw').fw.addRule('FORWARD', {
            src: '192.168.10.0/24', dst: '10.20.0.0/16', target: 'DROP', comment: 'temp-isolate-branch'
          });
          h.log('gw', 'kernel', 'netfilter: FORWARD rule added by change CHG-1142');
        },
        checks: [
          C.canPing('srv1', '10.20.5.10', 'Филиал из LAN'),
          C.canPing('srv1', '8.8.8.8', 'Интернет из LAN')
        ],
        solution: [
          'ping -c1 8.8.8.8',
          'ping -c1 10.20.5.10',
          'traceroute -n 10.20.5.10',
          'connect gw',
          'ping -c1 10.20.5.10',
          'ip route get 10.20.5.10',
          'sudo iptables -L FORWARD -n --line-numbers',
          'sudo iptables -D FORWARD -s 192.168.10.0/24 -d 10.20.0.0/16 -j DROP',
          'connect srv1',
          'ping -c1 10.20.5.10'
        ],
        hints: [
          'Интернет есть — значит, пересылка на gw включена. Трассировка до 10.20.5.10: на каком хопе обрыв?',
          'Шлюз отвечает, дальше — нет, хотя маршрут до филиала на gw правильный. Проверьте фильтр транзита: ' +
            '`sudo iptables -L FORWARD -n --line-numbers`.',
          'Правило DROP для 192.168.10.0/24 → 10.20.0.0/16. Удалите его: ' +
            '`sudo iptables -D FORWARD -s 192.168.10.0/24 -d 10.20.0.0/16 -j DROP` (или по номеру строки).'
        ],
        debrief: {
          why: 'Временное правило в цепочке FORWARD отбрасывало транзит из LAN в филиал. Трафик самого gw проходит ' +
            'через OUTPUT, а не FORWARD, поэтому с шлюза филиал был доступен — классическая ловушка при проверке ' +
            '«с роутера всё пингуется».',
          commands: [
            ['traceroute -n 10.20.5.10', 'обрыв сразу за шлюзом'],
            ['sudo iptables -L FORWARD -n --line-numbers', 'правило и его номер в цепочке'],
            ['sudo iptables -D FORWARD <номер>', 'удалить правило']
          ],
          theory: 'ip-forwarding'
        }
      }
    ]
  });
})(window.NET);
