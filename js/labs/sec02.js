/*
 * Sec 02 — поверхность атаки. Оборонительная задача: провести инвентаризацию
 * слушающих портов, увести внутренние службы на localhost и закрыть остальное
 * межсетевым экраном, не сломав работу пользователей.
 */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var SCAN = '198.51.100.77';
  var ADMIN = '198.51.100.200';
  var REDIS_CONF = '/etc/redis/redis.conf';
  var MYSQL_CONF = '/etc/mysql/mysql.conf.d/mysqld.cnf';

  var REDIS_TEXT = [
    '# Redis configuration file example.',
    '',
    '# По умолчанию Redis слушает все интерфейсы. Для сервера, где к нему',
    '# обращаются только локальные приложения, это лишнее.',
    'bind 0.0.0.0',
    'protected-mode no',
    'port 6379',
    '# requirepass foobared',
    'databases 16',
    ''
  ].join('\n');

  var MYSQL_TEXT = [
    '[mysqld]',
    'user            = mysql',
    'pid-file        = /run/mysqld/mysqld.pid',
    'socket          = /run/mysqld/mysqld.sock',
    'datadir         = /var/lib/mysql',
    'bind-address    = 0.0.0.0',
    'key_buffer_size = 16M',
    ''
  ].join('\n');

  /* Набор служб, который «достался по наследству»: база и кеш смотрят наружу. */
  function exposeStack(world, h) {
    h.service('srv1', {
      name: 'redis-server', description: 'Advanced key-value store',
      exec: '/usr/bin/redis-server 0.0.0.0:6379',
      ports: [{ proto: 'tcp', port: 6379 }],
      configFile: REDIS_CONF, configText: REDIS_TEXT,
      bindFrom: { file: REDIS_CONF, re: /^\s*bind\s+(.+)$/ }
    });
    h.service('srv1', {
      name: 'mysql', description: 'MySQL Community Server',
      exec: '/usr/sbin/mysqld',
      ports: [{ proto: 'tcp', port: 3306 }],
      configFile: MYSQL_CONF, configText: MYSQL_TEXT,
      bindFrom: { file: MYSQL_CONF, re: /^\s*bind-address\s*=\s*(.+)$/ }
    });
  }

  NET.labs.register({
    id: 'sec02',
    track: 'security',
    title: 'Поверхность атаки: лишние службы наружу',
    difficulty: 2,
    skills: ['security', 'firewall', 'services', 'tcpip'],
    topology: 'campus',
    brief: 'Аудит информационной безопасности прислал замечание по srv1:\n' +
      '«с внешнего адреса ' + SCAN + ' зафиксированы подключения к базе данных и кешу».\n' +
      'Сервер должен отдавать наружу только сайт (80/443) и принимать SSH.\n' +
      'MySQL и Redis используют локальные приложения на этом же сервере.\n\n' +
      'Проведите инвентаризацию слушающих портов и сократите поверхность атаки.\n' +
      'Пользователи сайта и администратор с ' + ADMIN + ' должны сохранить доступ.',
    goal: 'Наружу доступны только 22, 80 и 443; MySQL и Redis слушают localhost; ufw включён ' +
      'с политикой deny incoming; всё переживает перезагрузку.',

    setup: function (world, h) {
      exposeStack(world, h);
      h.log('srv1', 'redis-server', 'Ready to accept connections tcp');
      h.log('srv1', 'redis-server', 'Accepted connection from ' + SCAN + ':44510');
      h.log('srv1', 'mysqld', "Aborted connection to db unconnected (Got an error reading communication packets) from " + SCAN);
    },

    keySteps: [
      { id: 'inventory', title: 'Инвентаризация слушающих портов (ss -tulpn)', match: /^(sudo\s+)?(ss|netstat)\b/ },
      { id: 'fw', title: 'Проверить состояние firewall', match: /^(sudo\s+)?ufw\b/ },
      { id: 'conf', title: 'Найти адрес привязки в конфигурации службы', match: /(grep|cat|nano|vi|sed|tee).*(redis|mysql)/ },
      { id: 'restart', title: 'Перезапустить службу после правки', match: /systemctl\s+(restart|reload)\s+(redis|mysql)/ },
      { id: 'verify', title: 'Проверить результат с клиента', match: /^(connect\s+app1|nc|curl)\b/ }
    ],

    checks: [
      C.tcpClosed('attacker', '192.168.10.20', 6379, 'Redis закрыт снаружи', { srcIP: SCAN }),
      C.tcpClosed('attacker', '192.168.10.20', 3306, 'MySQL закрыт снаружи', { srcIP: SCAN }),
      C.fileHas('srv1', REDIS_CONF, 'bind 127.0.0.1'),
      C.fileHas('srv1', MYSQL_CONF, 'bind-address = 127.0.0.1'),
      C.portListening('srv1', 6379, 'tcp', '127.0.0.1'),
      C.portListening('srv1', 3306, 'tcp', '127.0.0.1'),
      C.ufwActive('srv1', 'deny'),
      C.tcpOpen('app1', '192.168.10.20', 443, 'Сайт для клиентов'),
      C.tcpOpen('app1', '192.168.10.20', 80, 'HTTP для клиентов'),
      C.tcpOpen('attacker', '192.168.10.20', 22, 'SSH администратора', { srcIP: ADMIN }),
      C.survivesReboot('srv1', [
        C.tcpClosed('attacker', '192.168.10.20', 6379, 'Redis закрыт снаружи', { srcIP: SCAN }),
        C.portListening('srv1', 3306, 'tcp', '127.0.0.1'),
        C.ufwActive('srv1', 'deny')
      ])
    ],

    solution: [
      'sudo ss -tulpn',
      'sudo ufw status',
      'journalctl -u redis-server -n 5',
      'sudo grep -n "^bind" /etc/redis/redis.conf',
      "sudo sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf",
      'sudo systemctl restart redis-server',
      'sudo grep -n "^bind-address" /etc/mysql/mysql.conf.d/mysqld.cnf',
      "sudo sed -i 's/^bind-address.*/bind-address = 127.0.0.1/' /etc/mysql/mysql.conf.d/mysqld.cnf",
      'sudo systemctl restart mysql',
      'sudo ss -tulpn',
      'sudo ufw default deny incoming',
      'sudo ufw default allow outgoing',
      'sudo ufw allow 22/tcp',
      'sudo ufw allow 80/tcp',
      'sudo ufw allow 443/tcp',
      'sudo ufw enable',
      'sudo ufw status verbose',
      'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1'
    ],

    hints: [
      'Начните с инвентаризации: `sudo ss -tulpn` — какие порты слушает сервер и на каких адресах? ' +
        'Сравните список с тем, что сервер обязан отдавать наружу (22, 80, 443). И проверьте `sudo ufw status`.',
      'Порты 6379 (Redis) и 3306 (MySQL) слушают 0.0.0.0 — то есть все адреса, включая внешний. ' +
        'Это два независимых слоя защиты: увести службы на localhost (адрес привязки в их конфигурации — ' +
        '`bind` в /etc/redis/redis.conf и `bind-address` в /etc/mysql/mysql.conf.d/mysqld.cnf) ' +
        'и закрыть остальное межсетевым экраном.',
      'Порядок: 1) `sudo sed -i \'s/^bind .*/bind 127.0.0.1 ::1/\' /etc/redis/redis.conf` и ' +
        '`sudo systemctl restart redis-server`; 2) то же для MySQL — `bind-address = 127.0.0.1` ' +
        'и `sudo systemctl restart mysql`; 3) `sudo ufw default deny incoming`, ' +
        '`sudo ufw allow 22/tcp`, `sudo ufw allow 80/tcp`, `sudo ufw allow 443/tcp`, затем `sudo ufw enable`. ' +
        'Проверьте `sudo ss -tulpn` — базы должны слушать 127.0.0.1.'
    ],

    debrief: {
      why: 'Поверхность атаки — это всё, до чего нападающий может дотянуться. Каждый порт, слушающий 0.0.0.0, ' +
        'доступен из любой сети, откуда есть маршрут. Базы данных и кеши проектировались для доверенной среды: ' +
        'Redis в конфигурации по умолчанию не требует пароля, поэтому его публикация наружу равносильна ' +
        'передаче данных любому желающему. Сокращают поверхность двумя независимыми слоями. ' +
        'Первый — привязка службы к 127.0.0.1: сокета на внешнем адресе просто нет, и ошибка в правилах ' +
        'firewall уже ничего не открывает. Второй — политика deny incoming с явным списком разрешённых портов: ' +
        'всё, что появится на сервере завтра, по умолчанию закрыто. Ни один из слоёв не заменяет другой: ' +
        'firewall можно случайно выключить, а служба может быть перенастроена при обновлении.',
      commands: [
        ['sudo ss -tulpn', 'инвентаризация: что слушает сервер и на каких адресах'],
        ['sudo ufw status verbose', 'политика по умолчанию и список разрешённых портов'],
        ['sudo grep -n "^bind" /etc/redis/redis.conf', 'адрес привязки Redis'],
        ['sudo grep -n "^bind-address" /etc/mysql/mysql.conf.d/mysqld.cnf', 'адрес привязки MySQL'],
        ['sudo systemctl restart redis-server', 'применить: сокет пересоздаётся при старте службы'],
        ['sudo ufw default deny incoming && sudo ufw allow 443/tcp', 'закрыть всё, открыть нужное'],
        ['nc -zv 192.168.10.20 443 (с клиента)', 'проверка, что сайт остался доступен']
      ],
      theory: 'attack-surface',
      pitfalls: [
        'Закрыть порт только firewall-ом и оставить службу на 0.0.0.0: одно неверное правило снова её откроет.',
        'Править конфигурацию и не перезапустить службу — сокет останется прежним.',
        'Включить ufw с политикой deny, забыв заранее разрешить 22, и потерять удалённый доступ. ' +
          'Сначала allow 22/tcp, потом enable.',
        'Проверять результат только на сервере: доступность снаружи проверяется с клиента.'
      ]
    },

    mutations: [
      {
        name: 'правило открыло базу всему интернету',
        brief: 'На srv1 межсетевой экран включён, но аудит снова фиксирует подключения к MySQL с ' + SCAN + '.\n' +
          'Администратор говорит, что «открывал порт только для сервера приложений app1 (192.168.10.30)».\n\n' +
          'Найдите ошибку в правилах, исправьте её и заодно уберите базу с внешнего адреса.\n' +
          'Сайт и SSH администратора с ' + ADMIN + ' должны продолжать работать.',
        setup: function (world, h) {
          exposeStack(world, h);
          var m = world.get('srv1');
          m.fw.ufw.enabled = true;
          m.fw.ufw.defaults.incoming = 'deny';
          m.services.start('ufw');
          m.services.enable('ufw');
          ['22', '80', '443'].forEach(function (p) {
            m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: p, from: 'any' });
          });
          /* правило без указания источника: открыто всем, а не только app1 */
          m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 3306, from: 'any',
            comment: 'app1 access' });
          h.log('srv1', 'mysqld', 'Connection from ' + SCAN + ' accepted');
        },
        checks: [
          C.tcpClosed('attacker', '192.168.10.20', 3306, 'MySQL закрыт снаружи', { srcIP: SCAN }),
          C.tcpClosed('attacker', '192.168.10.20', 6379, 'Redis закрыт снаружи', { srcIP: SCAN }),
          C.portListening('srv1', 3306, 'tcp', '127.0.0.1'),
          C.ufwActive('srv1', 'deny'),
          C.tcpOpen('app1', '192.168.10.20', 443, 'Сайт для клиентов'),
          C.tcpOpen('attacker', '192.168.10.20', 22, 'SSH администратора', { srcIP: ADMIN }),
          C.survivesReboot('srv1', [
            C.tcpClosed('attacker', '192.168.10.20', 3306, 'MySQL закрыт снаружи', { srcIP: SCAN })
          ])
        ],
        solution: [
          'sudo ufw status numbered',
          'sudo ss -tulpn',
          'sudo ufw delete allow 3306/tcp',
          'sudo grep -n "^bind-address" /etc/mysql/mysql.conf.d/mysqld.cnf',
          "sudo sed -i 's/^bind-address.*/bind-address = 127.0.0.1/' /etc/mysql/mysql.conf.d/mysqld.cnf",
          'sudo systemctl restart mysql',
          "sudo sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf",
          'sudo systemctl restart redis-server',
          'sudo ufw status verbose',
          'sudo ss -tulpn'
        ],
        hints: [
          '`sudo ufw status numbered` — посмотрите на колонку From у правила для 3306. Что там написано?',
          'В правиле указано Anywhere: `ufw allow 3306/tcp` открывает порт всем, а не только app1. ' +
            'Чтобы ограничить источник, правило пишут как `ufw allow from 192.168.10.30 to any port 3306 proto tcp`. ' +
            'Но здесь база нужна только локальным приложениям — значит, правило вообще лишнее, ' +
            'а службе место на 127.0.0.1.',
          'Удалите правило: `sudo ufw delete allow 3306/tcp`. Затем уведите базы на localhost: ' +
            "`sudo sed -i 's/^bind-address.*/bind-address = 127.0.0.1/' /etc/mysql/mysql.conf.d/mysqld.cnf` " +
            'и `sudo systemctl restart mysql`, то же для Redis. Проверьте `sudo ss -tulpn` и `sudo ufw status verbose`.'
        ],
        debrief: {
          why: 'Формулировка правила определяет, кому открыт порт. `ufw allow 3306/tcp` означает «с любого адреса», ' +
            'и комментарий «для app1» остаётся только пожеланием: фильтр читает правило, а не комментарий. ' +
            'Ограничение источника задаётся явно — `ufw allow from 192.168.10.30 to any port 3306 proto tcp`. ' +
            'Но самый надёжный ответ на вопрос «кто может подключиться к базе» — вообще не иметь сокета на внешнем ' +
            'адресе. Тогда правило, даже ошибочное, ничего не открывает: подключаться просто некуда.',
          commands: [
            ['sudo ufw status numbered', 'увидеть правила вместе с источниками и номерами'],
            ['sudo ufw delete allow 3306/tcp', 'удалить лишнее правило'],
            ['sudo ufw allow from 192.168.10.30 to any port 3306 proto tcp', 'форма правила с ограничением источника'],
            ['sudo ss -tulpn', 'проверить, на каком адресе слушает служба']
          ],
          theory: 'attack-surface'
        }
      },
      {
        name: 'забытый служебный порт',
        brief: 'После установки обновлений мониторинг обнаружил на srv1 открытый наружу порт 8080.\n' +
          'Никто не помнит, зачем он нужен: на нём отвечает служебная панель, оставшаяся от отладки.\n\n' +
          'Разберитесь, какая служба его слушает, уберите её и закройте поверхность атаки.\n' +
          'Сайт (80/443) и SSH с ' + ADMIN + ' должны работать.',
        setup: function (world, h) {
          exposeStack(world, h);
          h.service('srv1', {
            name: 'devpanel', description: 'Internal debug panel (temporary)',
            exec: '/opt/devpanel/server --listen 0.0.0.0:8080',
            ports: [{ proto: 'tcp', port: 8080 }]
          });
          h.log('srv1', 'devpanel', 'listening on 0.0.0.0:8080 (debug build)');
          h.log('srv1', 'devpanel', 'request from ' + SCAN + ' GET /status');
        },
        checks: [
          C.portClosed('srv1', 8080),
          C.custom('Служба devpanel снята с автозапуска', function (world) {
            var u = world.get('srv1').services.get('devpanel');
            if (!u) return { ok: true };
            if (u.state === 'active') return { ok: false, detail: 'служба всё ещё запущена' };
            return { ok: !u.enabled, detail: u.enabled ? 'остановлена, но вернётся после перезагрузки' : null };
          }),
          C.tcpClosed('attacker', '192.168.10.20', 8080, 'Служебная панель закрыта', { srcIP: SCAN }),
          C.tcpClosed('attacker', '192.168.10.20', 6379, 'Redis закрыт снаружи', { srcIP: SCAN }),
          C.ufwActive('srv1', 'deny'),
          C.tcpOpen('app1', '192.168.10.20', 443, 'Сайт для клиентов'),
          C.tcpOpen('attacker', '192.168.10.20', 22, 'SSH администратора', { srcIP: ADMIN }),
          C.survivesReboot('srv1', [
            C.portClosed('srv1', 8080),
            C.ufwActive('srv1', 'deny')
          ])
        ],
        solution: [
          'sudo ss -tulpn',
          'systemctl status devpanel',
          'journalctl -u devpanel -n 5',
          'sudo systemctl disable --now devpanel',
          "sudo sed -i 's/^bind .*/bind 127.0.0.1 ::1/' /etc/redis/redis.conf",
          'sudo systemctl restart redis-server',
          "sudo sed -i 's/^bind-address.*/bind-address = 127.0.0.1/' /etc/mysql/mysql.conf.d/mysqld.cnf",
          'sudo systemctl restart mysql',
          'sudo ufw default deny incoming',
          'sudo ufw allow 22/tcp',
          'sudo ufw allow 80/tcp',
          'sudo ufw allow 443/tcp',
          'sudo ufw enable',
          'sudo ss -tulpn'
        ],
        hints: [
          '`sudo ss -tulpn` покажет не только порт, но и процесс, который его слушает. ' +
            'По имени процесса найдите юнит: `systemctl status devpanel`.',
          'Панель отладки не нужна на рабочем сервере. Остановить мало — она вернётся после перезагрузки, ' +
            'если осталась в автозапуске. Нужен `systemctl disable --now`. ' +
            'Заодно закройте базы, которые тоже слушают 0.0.0.0.',
          '`sudo systemctl disable --now devpanel`, затем привязка Redis и MySQL к 127.0.0.1 с перезапуском, ' +
            'и ufw: `default deny incoming` + allow 22/80/443 + `enable`. Проверьте итог командой `sudo ss -tulpn`.'
        ],
        debrief: {
          why: 'Лишняя служба — это не просто открытый порт, а код, который никто не сопровождает: ' +
            'отладочные панели обычно не требуют аутентификации и пишутся без оглядки на безопасность. ' +
            'Правильная реакция — убрать саму службу, а не прятать её за firewall: ' +
            '`systemctl stop` без `disable` вернёт её при следующей перезагрузке. ' +
            'Инвентаризация портов с привязкой к процессам (ss -tulpn) — базовая регулярная практика: ' +
            'она отвечает на вопрос «что на этом сервере вообще слушает сеть» и выявляет такие находки.',
          commands: [
            ['sudo ss -tulpn', 'порт, адрес и процесс-владелец'],
            ['systemctl status devpanel', 'что это за служба и включена ли она в автозапуск'],
            ['sudo systemctl disable --now devpanel', 'остановить и убрать из автозапуска'],
            ['sudo ufw status verbose', 'итоговая политика']
          ],
          theory: 'attack-surface'
        }
      }
    ]
  });
})(window.NET);
