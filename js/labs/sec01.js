/*
 * Sec 01 — подбор паролей SSH. Оборонительная задача: увидеть атаку в журнале,
 * включить автоматическую блокировку источников и убрать то, что делает
 * подбор осмысленным (вход root по паролю).
 */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var BOTS = ['198.51.100.66', '198.51.100.67', '198.51.100.68'];
  var ADMIN = '198.51.100.200';

  var JAIL_LOCAL = "printf '[sshd]\\nenabled = true\\nmaxretry = 4\\nbantime = 1h\\nfindtime = 10m\\n' " +
    '| sudo tee /etc/fail2ban/jail.local';

  NET.labs.register({
    id: 'sec01',
    track: 'security',
    title: 'Подбор паролей SSH: закрыть вход',
    difficulty: 1,
    skills: ['security', 'services', 'troubleshooting', 'linux'],
    topology: 'campus',
    brief: 'Мониторинг ночью прислал предупреждение: журнал srv1 растёт на сотни строк в минуту,\n' +
      'все записи — от sshd. Сервер отвечает, но администраторы жалуются на медленный вход.\n\n' +
      'Разберитесь, что происходит, остановите это и закройте возможность повторить.\n' +
      'Важно: удалённый администратор работает с адреса ' + ADMIN + ' —\n' +
      'после ваших изменений он должен сохранить доступ по SSH.',
    goal: 'Источники подбора заблокированы автоматически, вход root по паролю запрещён, ' +
      'легитимный доступ с ' + ADMIN + ' сохранён, защита переживает перезагрузку.',

    setup: function (world, h) {
      /* пакет установлен, но ни один jail не включён — типичное «поставили и забыли» */
      h.fail2ban('srv1', { enabled: false, start: false });
      /* вход root по паролю разрешён: именно это и подбирают */
      h.editFile('srv1', '/etc/ssh/sshd_config',
        'PermitRootLogin prohibit-password', 'PermitRootLogin yes');
      world.get('srv1').services.restart('ssh');
      /* следы подбора в журнале sshd */
      BOTS.forEach(function (ip, i) {
        h.bruteForce('srv1', ip, 30 + i * 12, { user: 'root' });
        h.bruteForce('srv1', ip, 8, { user: 'admin', invalid: true });
      });
      h.log('srv1', 'sshd', 'error: maximum authentication attempts exceeded for root from ' +
        BOTS[0] + ' port 51234 ssh2 [preauth]', 'err');
    },

    keySteps: [
      { id: 'journal', title: 'Посмотреть журнал sshd (journalctl -u ssh)', match: /journalctl.*\b(ssh|sshd)\b|auth\.log/ },
      { id: 'count', title: 'Посчитать попытки по адресам (grep/sort/uniq)', match: /(uniq\s+-c|sort\b.*uniq|grep\s+-c)/ },
      { id: 'f2b', title: 'Проверить состояние fail2ban', match: /(systemctl\s+(status|is-active|is-enabled)\s+fail2ban|fail2ban-client)/ },
      { id: 'jail', title: 'Включить jail sshd (jail.local)', match: /jail\.local/ },
      { id: 'sshd', title: 'Закрыть вход root в sshd_config', match: /(nano|vi|vim|sed|tee).*sshd_config/ }
    ],

    checks: [
      C.serviceEnabled('srv1', 'fail2ban'),
      C.custom('Jail sshd включён в конфигурации fail2ban', function (world) {
        var m = world.get('srv1');
        var conf = NET.fail2ban.readConfig(m);
        return { ok: conf.sshd.enabled, detail: conf.sshd.enabled ? null : 'в jail.local нет enabled = true для [sshd]' };
      }),
      C.ipBanned('srv1', BOTS[0]),
      C.ipBanned('srv1', BOTS[1]),
      C.sshdOption('srv1', 'PermitRootLogin', 'no'),
      C.tcpOpen('attacker', '192.168.10.20', 22, 'SSH администратора сохранён', { srcIP: ADMIN }),
      C.tcpOpen('app1', '192.168.10.20', 22, 'SSH из локальной сети сохранён'),
      C.survivesReboot('srv1', [
        C.serviceEnabled('srv1', 'fail2ban'),
        C.ipBanned('srv1', BOTS[0]),
        C.sshdOption('srv1', 'PermitRootLogin', 'no')
      ])
    ],

    solution: [
      'journalctl -u ssh -n 20',
      'sudo grep "Failed password" /var/log/auth.log | grep -o "from [0-9.]*" | sort | uniq -c | sort -rn',
      'systemctl status fail2ban',
      'sudo cat /etc/fail2ban/jail.conf',
      JAIL_LOCAL,
      'sudo systemctl enable --now fail2ban',
      'sudo fail2ban-client status sshd',
      'sudo grep -n "^PermitRootLogin" /etc/ssh/sshd_config',
      "sudo sed -i 's/^PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config",
      'sudo sshd -t',
      'sudo systemctl restart ssh',
      'sudo fail2ban-client status sshd'
    ],

    hints: [
      'Сначала факты: `journalctl -u ssh -n 20` — что именно пишет sshd? ' +
        'Затем посчитайте, с каких адресов идут попытки: ' +
        '`sudo grep "Failed password" /var/log/auth.log | grep -o "from [0-9.]*" | sort | uniq -c | sort -rn`.',
      'Это подбор пароля к root с нескольких адресов. Руками блокировать каждый бесполезно — их будет больше. ' +
        'На сервере уже установлен fail2ban (`systemctl status fail2ban`), но ни один jail не включён. ' +
        'Включают их не в jail.conf, а в /etc/fail2ban/jail.local. И отдельно посмотрите ' +
        '`grep ^PermitRootLogin /etc/ssh/sshd_config` — зачем вообще пускать root по паролю?',
      'Решение из двух частей.\n' +
        '1) Автоблокировка: создайте /etc/fail2ban/jail.local с блоком\n' +
        '   [sshd]\n   enabled = true\n   maxretry = 4\n   bantime = 1h\n' +
        '   затем `sudo systemctl enable --now fail2ban` и проверьте `sudo fail2ban-client status sshd`.\n' +
        "2) Убрать цель: `sudo sed -i 's/^PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config`, " +
        'после `sudo sshd -t` — `sudo systemctl restart ssh`.'
    ],

    debrief: {
      why: 'Подбор пароля — самая массовая атака на открытый SSH: адреса перебирают пароли к root ' +
        'круглосуточно, автоматически. Ручная блокировка не работает, потому что адресов много и они меняются. ' +
        'Правильный ответ — двухслойный. Первый слой убирает саму цель: с PermitRootLogin no подбор пароля root ' +
        'теряет смысл, даже если пароль угадан. Второй слой автоматизирует реакцию: fail2ban читает журнал sshd, ' +
        'считает неудачные попытки с каждого адреса и после maxretry вставляет правило в netfilter. ' +
        'Пакет ставится в Ubuntu без единого включённого jail — «установлен» не значит «защищает», ' +
        'поэтому проверять надо fail2ban-client status, а не наличие пакета.',
      commands: [
        ['journalctl -u ssh -n 20', 'увидеть саму атаку, а не её последствия'],
        ['grep "Failed password" /var/log/auth.log | grep -o "from [0-9.]*" | sort | uniq -c | sort -rn',
          'частотный список источников: сразу видно масштаб и адреса'],
        ['systemctl status fail2ban', 'служба установлена, но запущена ли'],
        ['sudo fail2ban-client status sshd', 'главная проверка: jail работает, счётчики и список банов'],
        ['grep ^PermitRootLogin /etc/ssh/sshd_config', 'разрешён ли вход root'],
        ['sudo sshd -t && sudo systemctl restart ssh', 'проверить конфигурацию и применить']
      ],
      theory: 'ssh-hardening',
      pitfalls: [
        'Блокировать адреса вручную: их сотни, и завтра будут другие.',
        'Забыть systemctl enable — после перезагрузки защиты не станет.',
        'Заблокировать подсеть целиком и отрезать собственный удалённый доступ. ' +
          'Перед любым правилом на порт 22 проверьте, откуда работаете вы.',
        'Менять sshd_config и не перезапускать службу: действующая конфигурация читается при старте.'
      ]
    },

    mutations: [
      {
        name: 'подбор продолжается: jail слишком мягкий',
        brief: 'На srv1 fail2ban уже работает, но подбор идёт вторые сутки, и адреса не блокируются.\n' +
          'Администраторы отключили парольный вход не везде.\n\n' +
          'Разберитесь, почему защита не срабатывает, и доведите её до рабочего состояния.\n' +
          'Удалённый администратор работает с ' + ADMIN + ' — доступ ему сохраните.',
        setup: function (world, h) {
          /* jail включён, но maxretry огромный, а вся внешняя сеть в ignoreip */
          h.fail2ban('srv1', {
            enabled: true, start: true,
            jailLocal: '[DEFAULT]\nignoreip = 127.0.0.1/8 198.51.100.0/24\n\n[sshd]\nenabled = true\nmaxretry = 500\n'
          });
          h.editFile('srv1', '/etc/ssh/sshd_config',
            'PermitRootLogin prohibit-password', 'PermitRootLogin yes');
          world.get('srv1').services.restart('ssh');
          BOTS.forEach(function (ip) { h.bruteForce('srv1', ip, 40, { user: 'root' }); });
        },
        solution: [
          'sudo fail2ban-client status sshd',
          'sudo cat /etc/fail2ban/jail.local',
          "printf '[sshd]\\nenabled = true\\nmaxretry = 4\\nbantime = 1h\\nfindtime = 10m\\n' | sudo tee /etc/fail2ban/jail.local",
          'sudo systemctl restart fail2ban',
          'sudo fail2ban-client status sshd',
          "sudo sed -i 's/^PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config",
          'sudo sshd -t',
          'sudo systemctl restart ssh'
        ],
        hints: [
          '`sudo fail2ban-client status sshd` — сколько попыток зафиксировано и сколько адресов забанено? ' +
            'Если попытки считаются, а банов нет, дело в параметрах jail.',
          'Посмотрите `sudo cat /etc/fail2ban/jail.local`: maxretry = 500 практически недостижим, ' +
            'а в ignoreip внесена вся внешняя сеть 198.51.100.0/24 — адреса из неё fail2ban игнорирует. ' +
            'ignoreip нужен для своих адресов, а не для целой чужой сети.',
          'Перепишите /etc/fail2ban/jail.local: оставьте только [sshd] с enabled = true, maxretry = 4, ' +
            'bantime = 1h (ignoreip по умолчанию — 127.0.0.1/8). Затем `sudo systemctl restart fail2ban` ' +
            "и проверьте статус. Не забудьте `PermitRootLogin no` и перезапуск sshd."
        ],
        debrief: {
          why: 'Включённый fail2ban ещё не означает защиту: параметры jail решают, сработает ли он. ' +
            'maxretry = 500 означает, что бан наступит после пятисот попыток — за это время пароль успеют подобрать. ' +
            'Ещё опаснее ignoreip с чужой сетью: адреса оттуда fail2ban не банит никогда, ' +
            'то есть исключение из защиты выписано ровно тем, от кого защищаемся. ' +
            'В ignoreip место только своим адресам — рабочей сети, мониторингу, локальному хосту.',
          commands: [
            ['sudo fail2ban-client status sshd', 'счётчики попыток и банов — главный индикатор'],
            ['sudo cat /etc/fail2ban/jail.local', 'действующие параметры jail'],
            ['sudo systemctl restart fail2ban', 'перечитать конфигурацию'],
            ['sudo fail2ban-client set sshd unbanip <IP>', 'снять бан, если заблокировали своих']
          ],
          theory: 'ssh-hardening'
        }
      },
      {
        name: 'ключи вместо паролей',
        brief: 'Служба безопасности требует полностью отказаться от парольной аутентификации на srv1:\n' +
          'подбор пароля должен стать невозможным в принципе.\n\n' +
          'Ключ администратора уже развёрнут на сервере, вход по ключу работает.\n' +
          'Переведите sshd на аутентификацию по ключам, оставив автоблокировку источников,\n' +
          'и сохраните доступ администратору с ' + ADMIN + '.',
        setup: function (world, h) {
          h.fail2ban('srv1', { enabled: false, start: false });
          h.editFile('srv1', '/etc/ssh/sshd_config',
            'PermitRootLogin prohibit-password', 'PermitRootLogin yes');
          h.writeFile('srv1', '/home/user/.ssh/authorized_keys',
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK7xQ0admin-workstation admin@corp\n', 0o600);
          world.get('srv1').services.restart('ssh');
          BOTS.forEach(function (ip) { h.bruteForce('srv1', ip, 25, { user: 'root' }); });
        },
        checks: [
          C.sshdOption('srv1', 'PasswordAuthentication', 'no'),
          C.sshdOption('srv1', 'PermitRootLogin', 'no'),
          C.sshdOption('srv1', 'PubkeyAuthentication', 'yes'),
          C.serviceEnabled('srv1', 'fail2ban'),
          C.fileHas('srv1', '/home/user/.ssh/authorized_keys', 'ssh-ed25519'),
          C.tcpOpen('attacker', '192.168.10.20', 22, 'SSH администратора сохранён', { srcIP: ADMIN }),
          C.survivesReboot('srv1', [
            C.sshdOption('srv1', 'PasswordAuthentication', 'no'),
            C.serviceEnabled('srv1', 'fail2ban')
          ])
        ],
        solution: [
          'sudo grep -nE "^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication)" /etc/ssh/sshd_config',
          'sudo cat /home/user/.ssh/authorized_keys',
          "sudo sed -i 's/^PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config",
          "sudo sed -i 's/^PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config",
          "sudo sed -i 's/^PubkeyAuthentication .*/PubkeyAuthentication yes/' /etc/ssh/sshd_config",
          'sudo sshd -t',
          'sudo systemctl restart ssh',
          JAIL_LOCAL,
          'sudo systemctl enable --now fail2ban',
          'sudo fail2ban-client status sshd'
        ],
        hints: [
          'Прежде чем выключать пароли, убедитесь, что вход по ключу возможен: ' +
            '`sudo cat /home/user/.ssh/authorized_keys` — ключ на месте? Это страховка от потери доступа.',
          'Нужны три директивы в /etc/ssh/sshd_config: PermitRootLogin no, PasswordAuthentication no, ' +
            'PubkeyAuthentication yes. Плюс оставить автоблокировку (fail2ban с включённым jail sshd).',
          "Правьте по одной: `sudo sed -i 's/^PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config` " +
            '(и так же для остальных), затем `sudo sshd -t` и `sudo systemctl restart ssh`. ' +
            'Для fail2ban — jail.local с enabled = true и `sudo systemctl enable --now fail2ban`.'
        ],
        debrief: {
          why: 'Отключение парольной аутентификации закрывает класс атак целиком: подбирать нечего, ' +
            'ключ подобрать нельзя. Это сильнее любой блокировки по журналу, поэтому в проде это основная мера, ' +
            'а fail2ban остаётся вторым слоем — он снимает шум и нагрузку от постоянных попыток. ' +
            'Главное правило при такой правке: сначала убедиться, что ключ работает, и только потом выключать пароли — ' +
            'иначе можно закрыть доступ самому себе. Безопасный порядок: проверить authorized_keys, ' +
            'править конфигурацию, `sshd -t`, перезапуск, и лишь затем закрывать текущую сессию.',
          commands: [
            ['sudo cat /home/user/.ssh/authorized_keys', 'проверить, что ключ на месте — страховка от потери доступа'],
            ['sudo grep -nE "^(PermitRootLogin|PasswordAuthentication)" /etc/ssh/sshd_config', 'текущие директивы'],
            ['sudo sshd -t', 'проверка синтаксиса до перезапуска'],
            ['sudo systemctl restart ssh', 'применить новую политику входа'],
            ['sudo fail2ban-client status sshd', 'второй слой на месте']
          ],
          theory: 'ssh-hardening'
        }
      }
    ]
  });
})(window.NET);
