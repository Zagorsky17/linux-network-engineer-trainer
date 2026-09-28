/*
 * Sec 05 — разбор компрометации. Оборонительная задача уровня «реакция на
 * инцидент»: подтвердить факт проникновения, найти все точки закрепления,
 * убрать их, закрыть путь входа и вернуть сервис в доверенное состояние.
 */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var INTRUDER = '198.51.100.66';
  var ADMIN = '198.51.100.200';

  /* Штатные SUID-файлы образа: всё, чего нет в списке, — находка аудита. */
  var SUID_BASELINE = [
    '/usr/bin/sudo', '/usr/bin/passwd', '/usr/bin/su', '/usr/bin/mount', '/usr/bin/umount',
    '/usr/bin/chsh', '/usr/bin/newgrp', '/usr/bin/gpasswd', '/usr/lib/openssh/ssh-keysign'
  ];

  var ADMIN_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK7xQ0admin-workstation admin@corp';
  var FOREIGN_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFzz9unknown-origin backup@unknown';

  NET.labs.register({
    id: 'sec05',
    track: 'security',
    title: 'Компрометация: разбор и восстановление доверия',
    difficulty: 5,
    skills: ['security', 'troubleshooting', 'linux', 'services', 'firewall'],
    topology: 'campus',
    brief: 'Ночью на srv1 сработал подбор пароля, и утром в журнале есть успешный вход с ' + INTRUDER + '.\n' +
      'Сервер работает, сайт открывается — но доверять ему больше нельзя.\n\n' +
      'Проведите разбор по всем направлениям закрепления:\n' +
      '  • учётные записи и права;      • автозапуск (systemd, cron);\n' +
      '  • слушающие порты;             • ключи доступа SSH;\n' +
      '  • правила межсетевого экрана;  • файлы с признаком повышения прав (SUID).\n\n' +
      'Уберите все найденные следы, закройте путь входа и сохраните работу сайта\n' +
      'и доступ администратора с ' + ADMIN + '. Всё должно пережить перезагрузку.',
    goal: 'Посторонних учётных записей, задач cron, служб, портов, ключей и SUID-файлов нет; ' +
      'вход root по паролю закрыт; сайт и SSH администратора работают.',

    setup: function (world, h) {
      var m = world.get('srv1');

      /* как вошли: вход root по паролю был разрешён */
      h.editFile('srv1', '/etc/ssh/sshd_config', 'PermitRootLogin prohibit-password', 'PermitRootLogin yes');
      m.services.restart('ssh');
      h.bruteForce('srv1', INTRUDER, 40, { user: 'root' });
      h.log('srv1', 'sshd', 'Accepted password for root from ' + INTRUDER + ' port 51442 ssh2');
      h.log('srv1', 'sshd', 'pam_unix(sshd:session): session opened for user root(uid=0)');

      /* 1. вторая учётная запись с правами суперпользователя */
      h.addUser('srv1', { name: 'support', uid: 0, group: 'root', gid: 0, home: '/root', gecos: 'system' });
      h.log('srv1', 'useradd', "new user: name=support, UID=0, GID=0");

      /* 2. файл с битом SUID вне штатного списка */
      h.writeFile('srv1', '/usr/local/bin/.sysd', '\x7fELF (stub)\n', 0o4755);

      /* 3. закрепление через cron */
      h.writeFile('srv1', '/etc/cron.d/apache2-update',
        '# apache2 update helper\n*/5 * * * * root /usr/local/bin/.sysd --check\n', 0o644);

      /* 4. служба, слушающая нестандартный порт */
      h.service('srv1', {
        name: 'sysupdate', description: 'System Update Helper',
        exec: '/usr/local/bin/.sysd --daemon',
        ports: [{ proto: 'tcp', port: 4444 }]
      });

      /* 5. посторонний ключ рядом с рабочим */
      h.writeFile('srv1', '/home/user/.ssh/authorized_keys', ADMIN_KEY + '\n' + FOREIGN_KEY + '\n', 0o600);

      /* 6. правило, открывающее этот порт наружу */
      m.fw.ufw.enabled = true;
      m.fw.ufw.defaults.incoming = 'deny';
      ['22', '80', '443'].forEach(function (p) {
        m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: p, from: 'any' });
      });
      m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 4444, from: 'any' });
      m.services.start('ufw');
      m.services.enable('ufw');
    },

    keySteps: [
      { id: 'confirm', title: 'Подтвердить факт входа (журнал, last)', match: /(journalctl|last\b|auth\.log|Accepted)/ },
      { id: 'users', title: 'Проверить учётные записи (uid 0)', match: /(awk.*passwd|getent\s+passwd|cat.*\/etc\/passwd|grep.*passwd)/ },
      { id: 'ports', title: 'Проверить слушающие порты', match: /^(sudo\s+)?(ss|netstat)\b/ },
      { id: 'units', title: 'Проверить службы и автозапуск', match: /(systemctl|systemd)/ },
      { id: 'cron', title: 'Проверить задания cron', match: /(cron|crontab)/ },
      { id: 'suid', title: 'Найти файлы с битом SUID', match: /find.*perm/ },
      { id: 'keys', title: 'Проверить ключи SSH', match: /authorized_keys/ },
      { id: 'fw', title: 'Проверить правила firewall', match: /^(sudo\s+)?ufw\b/ }
    ],

    checks: [
      C.noExtraRootUsers('srv1'),
      C.userAbsent('srv1', 'support'),
      C.noExtraSuid('srv1', SUID_BASELINE),
      C.fileAbsent('srv1', '/etc/cron.d/apache2-update', 'Задания cron нет'),
      C.portClosed('srv1', 4444),
      C.tcpClosed('attacker', '192.168.10.20', 4444, 'Порт 4444 закрыт снаружи', { srcIP: INTRUDER }),
      C.fileHas('srv1', '/home/user/.ssh/authorized_keys', 'backup@unknown', { absent: true }),
      C.fileHas('srv1', '/home/user/.ssh/authorized_keys', 'admin@corp'),
      C.sshdOption('srv1', 'PermitRootLogin', 'no'),
      C.httpStatus('app1', '192.168.10.20', 80, '/', 200, 'Сайт работает для клиентов'),
      C.tcpOpen('attacker', '192.168.10.20', 22, 'SSH администратора сохранён', { srcIP: ADMIN }),
      C.survivesReboot('srv1', [
        C.portClosed('srv1', 4444),
        C.noExtraRootUsers('srv1'),
        C.sshdOption('srv1', 'PermitRootLogin', 'no'),
        C.httpStatus('app1', '192.168.10.20', 80, '/', 200, 'Сайт работает для клиентов')
      ])
    ],

    solution: [
      /* 1. подтвердить факт */
      'journalctl -u ssh | grep Accepted',
      'last -n 10',
      /* 2. учётные записи */
      "awk -F: '$3==0 {print $1}' /etc/passwd",
      'sudo userdel support',
      /* 3. порты и службы */
      'sudo ss -tulpn',
      'systemctl status sysupdate',
      'sudo systemctl disable --now sysupdate',
      /* 4. автозапуск через cron */
      'ls -la /etc/cron.d',
      'sudo cat /etc/cron.d/apache2-update',
      'sudo rm /etc/cron.d/apache2-update',
      /* 5. файлы с SUID */
      'sudo find / -perm -4000 -type f',
      'sudo rm /usr/local/bin/.sysd',
      /* 6. ключи доступа */
      'sudo cat /home/user/.ssh/authorized_keys',
      "sudo sed -i '/backup@unknown/d' /home/user/.ssh/authorized_keys",
      /* 7. правила firewall */
      'sudo ufw status numbered',
      'sudo ufw delete allow 4444/tcp',
      /* 8. закрыть путь входа */
      "sudo sed -i 's/^PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config",
      'sudo sshd -t',
      'sudo systemctl restart ssh',
      /* 9. проверка */
      'sudo ss -tulpn',
      'sudo find / -perm -4000 -type f',
      'sudo ufw status numbered'
    ],

    hints: [
      'Сначала подтвердите факт: `journalctl -u ssh | grep Accepted` и `last -n 10`. ' +
        'Если вход состоялся, дальше работайте по списку направлений закрепления из задания — ' +
        'по одному, ничего не пропуская. Начните с учётных записей: ' +
        "`awk -F: '$3==0 {print $1}' /etc/passwd` покажет всех с правами суперпользователя.",
      'Шесть находок, по одной на каждое направление:\n' +
        '  • учётная запись support с uid 0 (`userdel support`);\n' +
        '  • служба sysupdate на порту 4444 (`ss -tulpn`, затем `systemctl disable --now`);\n' +
        '  • задание в /etc/cron.d/apache2-update (`ls -la /etc/cron.d`);\n' +
        '  • файл /usr/local/bin/.sysd с битом SUID (`find / -perm -4000 -type f`);\n' +
        '  • посторонний ключ backup@unknown в /home/user/.ssh/authorized_keys;\n' +
        '  • правило ufw, открывающее 4444 (`ufw status numbered`).\n' +
        'И отдельно — путь входа: PermitRootLogin yes в /etc/ssh/sshd_config.',
      'Порядок команд:\n' +
        '`sudo userdel support`; `sudo systemctl disable --now sysupdate`; ' +
        '`sudo rm /etc/cron.d/apache2-update`; `sudo rm /usr/local/bin/.sysd`; ' +
        "`sudo sed -i '/backup@unknown/d' /home/user/.ssh/authorized_keys`; " +
        '`sudo ufw delete allow 4444/tcp`; ' +
        "`sudo sed -i 's/^PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config` + " +
        '`sudo sshd -t` + `sudo systemctl restart ssh`.\n' +
        'В конце повторите `sudo ss -tulpn` и `sudo find / -perm -4000 -type f` — ' +
        'списки должны стать чистыми.'
    ],

    debrief: {
      why: 'Компрометация отличается от поломки тем, что у происходящего есть автор, который заинтересован ' +
        'сохранить доступ. Поэтому разбор ведут не по симптому, а по списку направлений закрепления, ' +
        'и проходят его целиком: учётные записи, автозапуск (systemd и cron), слушающие порты, ключи доступа, ' +
        'правила межсетевого экрана, файлы с битом SUID. Пропущенная точка обесценивает всю работу: ' +
        'через неё доступ вернётся, и следующий разбор начнётся с нуля.\n\n' +
        'Каждая находка здесь показательна. Учётная запись с uid 0 — это второй root: система различает ' +
        'пользователей по идентификатору, а не по имени, поэтому support с uid 0 обладает всеми правами. ' +
        'Бит SUID на файле означает, что он выполняется с правами владельца, то есть даёт способ вернуть ' +
        'себе права root без пароля — именно поэтому список SUID-файлов сверяют с эталонным. ' +
        'Задание в /etc/cron.d и включённый юнит systemd дают запуск после перезагрузки. ' +
        'Посторонний ключ в authorized_keys — вход вообще без пароля, мимо всех политик. ' +
        'Правило firewall, открывающее нестандартный порт, делает точку входа доступной снаружи.\n\n' +
        'Закрывать нужно и сам путь входа, иначе история повторится: вход root по паролю запрещают, ' +
        'а лучше переходят на ключи. И последнее: после такого разбора сервер считается восстановленным ' +
        'лишь условно. В реальной практике скомпрометированный сервер переустанавливают, а пароли и ключи, ' +
        'которые на нём были, считают известными посторонним и меняют — потому что гарантировать, ' +
        'что найдено всё, нельзя.',
      commands: [
        ['journalctl -u ssh | grep Accepted', 'подтверждение факта входа'],
        ["awk -F: '$3==0 {print $1}' /etc/passwd", 'все учётные записи с правами суперпользователя'],
        ['sudo ss -tulpn', 'посторонние слушающие порты и их процессы'],
        ['systemctl list-units --type=service', 'что запущено и что включено в автозапуск'],
        ['ls -la /etc/cron.d', 'закрепление через планировщик'],
        ['sudo find / -perm -4000 -type f', 'файлы, выполняемые с правами владельца'],
        ['sudo cat /home/user/.ssh/authorized_keys', 'ключи, дающие вход без пароля'],
        ['sudo ufw status numbered', 'правила, открывающие посторонние порты'],
        ['sudo sshd -t && sudo systemctl restart ssh', 'закрыть путь входа']
      ],
      theory: 'incident-response',
      pitfalls: [
        'Остановиться после первой находки: точек закрепления обычно несколько.',
        'Остановить службу без disable — она вернётся после перезагрузки.',
        'Убрать следы и не закрыть путь входа: доступ восстановят тем же способом.',
        'Удалить учётную запись и забыть про её ключи, задачи cron и правила firewall.',
        'Считать очищенный сервер полностью доверенным: пароли и ключи с него подлежат замене.'
      ]
    },

    mutations: [
      {
        name: 'закрепление в автозапуске пользователя',
        brief: 'На srv1 зафиксирован успешный вход с ' + INTRUDER + '. Первичная очистка уже проведена:\n' +
          'посторонних учётных записей нет, /etc/cron.d чист, лишних служб systemd не видно.\n' +
          'Тем не менее на сервере снова появляется процесс, которого там быть не должно,\n' +
          'а наружу открыт порт 9001.\n\n' +
          'Найдите оставшиеся точки закрепления и уберите их. Сайт и доступ с ' + ADMIN + ' сохраните.',
        setup: function (world, h) {
          var m = world.get('srv1');
          h.editFile('srv1', '/etc/ssh/sshd_config', 'PermitRootLogin prohibit-password', 'PermitRootLogin yes');
          m.services.restart('ssh');
          h.log('srv1', 'sshd', 'Accepted password for root from ' + INTRUDER + ' port 52001 ssh2');

          /* закрепление в crontab пользователя, а не в /etc/cron.d */
          h.writeFile('srv1', '/var/spool/cron/crontabs/user',
            '# m h  dom mon dow   command\n@reboot /usr/local/bin/.upd --daemon\n', 0o600);
          h.writeFile('srv1', '/usr/local/bin/.upd', '\x7fELF (stub)\n', 0o4755);
          h.service('srv1', {
            name: 'netmon', description: 'Network Monitor Agent',
            exec: '/usr/local/bin/.upd --daemon',
            ports: [{ proto: 'tcp', port: 9001 }]
          });
          h.writeFile('srv1', '/home/user/.ssh/authorized_keys', ADMIN_KEY + '\n' + FOREIGN_KEY + '\n', 0o600);
          m.fw.ufw.enabled = true;
          m.fw.ufw.defaults.incoming = 'deny';
          ['22', '80', '443'].forEach(function (p) {
            m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: p, from: 'any' });
          });
          m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 9001, from: 'any' });
          m.services.start('ufw');
          m.services.enable('ufw');
        },
        checks: [
          C.portClosed('srv1', 9001),
          C.tcpClosed('attacker', '192.168.10.20', 9001, 'Порт 9001 закрыт снаружи', { srcIP: INTRUDER }),
          C.fileAbsent('srv1', '/var/spool/cron/crontabs/user', 'Задания в crontab пользователя нет'),
          C.noExtraSuid('srv1', SUID_BASELINE),
          C.fileHas('srv1', '/home/user/.ssh/authorized_keys', 'backup@unknown', { absent: true }),
          C.fileHas('srv1', '/home/user/.ssh/authorized_keys', 'admin@corp'),
          C.sshdOption('srv1', 'PermitRootLogin', 'no'),
          C.httpStatus('app1', '192.168.10.20', 80, '/', 200, 'Сайт работает для клиентов'),
          C.tcpOpen('attacker', '192.168.10.20', 22, 'SSH администратора сохранён', { srcIP: ADMIN }),
          C.survivesReboot('srv1', [
            C.portClosed('srv1', 9001),
            C.sshdOption('srv1', 'PermitRootLogin', 'no')
          ])
        ],
        solution: [
          'journalctl -u ssh | grep Accepted',
          'sudo ss -tulpn',
          'systemctl status netmon',
          'sudo systemctl disable --now netmon',
          'ls -la /etc/cron.d',
          'sudo crontab -l -u user',
          'sudo rm /var/spool/cron/crontabs/user',
          'sudo find / -perm -4000 -type f',
          'sudo rm /usr/local/bin/.upd',
          'sudo cat /home/user/.ssh/authorized_keys',
          "sudo sed -i '/backup@unknown/d' /home/user/.ssh/authorized_keys",
          'sudo ufw status numbered',
          'sudo ufw delete allow 9001/tcp',
          "sudo sed -i 's/^PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config",
          'sudo sshd -t',
          'sudo systemctl restart ssh',
          'sudo ss -tulpn'
        ],
        hints: [
          'Каталог /etc/cron.d — не единственное место, где живут задания планировщика. ' +
            'У каждого пользователя есть собственный crontab: `sudo crontab -l -u user`. ' +
            'И начните с `sudo ss -tulpn` — что слушает порт 9001?',
          'Четыре находки: служба netmon (systemd), задание @reboot в crontab пользователя user, ' +
            'файл /usr/local/bin/.upd с битом SUID и посторонний ключ в authorized_keys. ' +
            'Плюс правило ufw для 9001 и открытый вход root по паролю.',
          '`sudo systemctl disable --now netmon`; `sudo rm /var/spool/cron/crontabs/user`; ' +
            '`sudo rm /usr/local/bin/.upd`; `sudo sed -i \'/backup@unknown/d\' /home/user/.ssh/authorized_keys`; ' +
            '`sudo ufw delete allow 9001/tcp`; и закройте вход: PermitRootLogin no с перезапуском sshd.'
        ],
        debrief: {
          why: 'Планировщик — это не один каталог. Задания живут в /etc/crontab, /etc/cron.d, каталогах ' +
            'cron.hourly и подобных, а также в личных crontab каждого пользователя ' +
            '(/var/spool/cron/crontabs). Проверка только /etc/cron.d создаёт ложное ощущение чистоты: ' +
            'запись @reboot в пользовательском crontab переживёт перезагрузку и вернёт процесс. ' +
            'Отсюда общее правило разбора: по каждому направлению закрепления проверяют все его места, ' +
            'а не первое попавшееся. Итоговая проверка — повторный ss -tulpn и find по SUID: ' +
            'если списки чисты и после перезагрузки, работу можно считать завершённой.',
          commands: [
            ['sudo ss -tulpn', 'посторонний порт и его процесс'],
            ['sudo crontab -l -u user', 'личный crontab пользователя'],
            ['ls -la /etc/cron.d /etc/cron.daily', 'системные задания'],
            ['sudo find / -perm -4000 -type f', 'файлы с битом SUID'],
            ['sudo ufw status numbered', 'правила для посторонних портов']
          ],
          theory: 'incident-response'
        }
      }
    ]
  });
})(window.NET);
