/*
 * Sec 04 — защита веб-приложения. Оборонительная задача: разобрать журнал
 * веб-сервера, понять, что сканер сумел скачать, убрать лишнее из веб-корня
 * и закрыть служебные пути правилами nginx, не сломав сайт.
 */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var SCAN = '198.51.100.77';
  var ADMIN = '198.51.100.200';
  var SITE = '/etc/nginx/sites-available/default';
  var WEB = '/var/www/html';

  /* Правило nginx, закрывающее все пути, начинающиеся с точки. */
  var DENY_DOT = "sudo sed -i 's|index index.html;|index index.html;\\n        location ~ /\\\\. { deny all; }|' " + SITE;
  /* Правило, закрывающее выгрузки и архивы. */
  /* разделитель @: в правиле есть | (альтернация), и как разделитель он бы всё сломал */
  var DENY_DUMP = "sudo sed -i 's@index index.html;@index index.html;\\n        location ~* \\\\.(sql|bak|zip|tar)$ { deny all; }@' " + SITE;

  /* Журнал сканирования: типовые пути, которые перебирают автоматические сканеры. */
  function scanLog(h, hits) {
    var probes = [
      { path: '/.git/config', status: hits ? 200 : 404 },
      { path: '/.env', status: hits ? 200 : 404 },
      { path: '/backup.sql', status: hits ? 200 : 404 },
      { path: '/admin', status: 404 },
      { path: '/wp-login.php', status: 404 },
      { path: '/phpinfo.php', status: 404 },
      { path: '/../../etc/passwd', status: 400 },
      { path: '/.svn/entries', status: 404 }
    ];
    var entries = [];
    for (var round = 0; round < 3; round++) {
      probes.forEach(function (p, i) {
        entries.push({ ip: SCAN, path: p.path, status: p.status, size: p.status === 200 ? 1840 : 162,
          ua: 'Mozilla/5.0 (compatible; scanner)', ts: Date.now() - (30 - round * 8 - i) * 1000 });
      });
    }
    entries.push({ ip: '192.168.10.30', path: '/', status: 200, size: 612, ua: 'curl/8.5.0', ts: Date.now() - 4000 });
    h.accessLog('srv1', entries);
  }

  /* Служебные файлы, оказавшиеся в веб-корне при выкладке сайта. */
  function leftovers(h) {
    h.writeFile('srv1', WEB + '/.git/config', [
      '[core]',
      '\trepositoryformatversion = 0',
      '[remote "origin"]',
      '\turl = https://git.corp.local/site.git',
      ''
    ].join('\n'), 0o644);
    h.writeFile('srv1', WEB + '/.env', [
      '# файл настроек приложения (в веб-корне ему не место)',
      'APP_ENV=production',
      'APP_DEBUG=false',
      'DB_HOST=127.0.0.1',
      ''
    ].join('\n'), 0o644);
    h.writeFile('srv1', WEB + '/backup.sql', [
      '-- MySQL dump 10.13  Distrib 8.0.36',
      '-- Host: localhost    Database: corp_site',
      '-- (выгрузка базы, оставленная после переноса сайта)',
      ''
    ].join('\n'), 0o644);
  }

  NET.labs.register({
    id: 'sec04',
    track: 'security',
    title: 'Сканирование веб-приложения: закрыть лишнее',
    difficulty: 4,
    skills: ['security', 'services', 'linux', 'troubleshooting'],
    topology: 'campus',
    brief: 'Служба мониторинга обратила внимание на рост трафика к сайту srv1 с адреса ' + SCAN + '.\n' +
      'Сайт работает, ошибок нет — но запросы идут не к страницам, а к служебным путям.\n\n' +
      'Разберите журнал веб-сервера: выясните, что сканер запрашивал и что ему отдали.\n' +
      'Уберите из веб-корня то, чего там быть не должно, и закройте служебные пути.\n' +
      'Сайт должен остаться доступным клиентам и администратору с ' + ADMIN + '.',
    goal: 'Служебные файлы недоступны по HTTP и убраны из веб-корня, правило nginx закрывает пути ' +
      'с точкой, сайт отвечает клиентам, конфигурация переживает перезагрузку.',

    setup: function (world, h) {
      leftovers(h);
      scanLog(h, true);
      h.log('srv1', 'nginx', 'GET /.git/config HTTP/1.1" 200 — служебный путь отдан клиенту', 'warning');
    },

    keySteps: [
      { id: 'log', title: 'Изучить журнал веб-сервера', match: /access\.log/ },
      { id: 'freq', title: 'Построить частотный список путей или источников', match: /(uniq\s+-c|sort\s+-rn)/ },
      { id: 'web', title: 'Посмотреть содержимое веб-корня', match: /(ls|find|tree).*\/var\/www/ },
      { id: 'nginx', title: 'Изменить конфигурацию nginx', match: /(nano|vi|sed|tee).*(nginx|sites-)/ },
      { id: 'check', title: 'Проверить результат запросом', match: /^(curl|wget)\b/ }
    ],

    checks: [
      C.httpStatus('attacker', '192.168.10.20', 80, '/.git/config', 403, 'Каталог .git закрыт'),
      C.httpStatus('attacker', '192.168.10.20', 80, '/.env', 403, 'Файл .env закрыт'),
      C.fileAbsent('srv1', WEB + '/backup.sql', 'Выгрузки базы нет в веб-корне'),
      C.httpStatus('attacker', '192.168.10.20', 80, '/backup.sql', 404, 'Выгрузка недоступна по HTTP'),
      C.fileHas('srv1', SITE, 'deny all'),
      C.httpStatus('app1', '192.168.10.20', 80, '/', 200, 'Сайт работает для клиентов'),
      C.httpStatus('attacker', '192.168.10.20', 80, '/', 200, 'Сайт доступен снаружи'),
      C.survivesReboot('srv1', [
        C.httpStatus('attacker', '192.168.10.20', 80, '/.git/config', 403, 'Каталог .git закрыт'),
        C.httpStatus('app1', '192.168.10.20', 80, '/', 200, 'Сайт работает для клиентов')
      ])
    ],

    solution: [
      'sudo tail -20 /var/log/nginx/access.log',
      'sudo grep -o \'"GET [^ ]*\' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -10',
      'sudo grep " 200 " /var/log/nginx/access.log | grep -v \'GET / \'',
      'ls -la /var/www/html',
      'sudo mkdir -p /var/backups',
      'sudo mv /var/www/html/backup.sql /var/backups/backup.sql',
      'sudo chmod 600 /var/backups/backup.sql',
      DENY_DOT,
      'sudo nginx -t',
      'sudo systemctl reload nginx',
      'curl -s -I http://127.0.0.1/.git/config',
      'curl -s -I http://127.0.0.1/',
      'sudo grep -c " 200 " /var/log/nginx/access.log'
    ],

    hints: [
      'Начните с журнала: `sudo tail -20 /var/log/nginx/access.log`. Какие пути запрашивают? ' +
        'Постройте частотный список: `sudo grep -o \'"GET [^ ]*\' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head`. ' +
        'И главное — отделите то, что сервер отдал с кодом 200, от того, что ответило 404.',
      'Сканер перебирает типовые служебные пути. Коды 404 — промахи, а вот 200 означает, что файл ' +
        'реально отдан: посмотрите `ls -la /var/www/html`. В веб-корне лежат .git, .env и выгрузка базы. ' +
        'Нужны две меры: убрать лишние файлы из веб-корня (переместить, а не удалить) и закрыть ' +
        'пути, начинающиеся с точки, правилом nginx `location ~ /\\. { deny all; }`.',
      'Решение:\n' +
        '1) `sudo mkdir -p /var/backups && sudo mv /var/www/html/backup.sql /var/backups/` и `sudo chmod 600 /var/backups/backup.sql`;\n' +
        '2) добавьте в /etc/nginx/sites-available/default внутрь блока server строку\n' +
        '   location ~ /\\. { deny all; }\n' +
        '   (`sudo nano ' + SITE + '`), затем `sudo nginx -t` и `sudo systemctl reload nginx`;\n' +
        '3) проверьте: `curl -s -I http://127.0.0.1/.git/config` должен вернуть 403, а `curl -s -I http://127.0.0.1/` — 200.'
    ],

    debrief: {
      why: 'Автоматические сканеры перебирают несколько десятков типовых путей: каталоги систем контроля версий, ' +
        'файлы настроек, выгрузки баз, панели администрирования. Почти все запросы получают 404 — это фон. ' +
        'Значение имеет единственный признак: ответ 200 на служебный путь. Он означает, что файл действительно ' +
        'отдан, и разбор нужно начинать с вопроса «что именно утекло». Поэтому журнал читают не целиком, ' +
        'а фильтром по коду ответа. Защита строится в два слоя. Первый — порядок в веб-корне: каталогам .git, ' +
        'файлам настроек и выгрузкам базы там не место, их переносят за пределы корня и закрывают права. ' +
        'Перемещение лучше удаления: данные сохраняются для разбора и восстановления. Второй слой — правило ' +
        'веб-сервера, закрывающее целый класс путей: location ~ /\\. { deny all; } отвечает 403 на всё, ' +
        'что начинается с точки, включая файлы, о которых вы ещё не знаете. Попытки выхода за пределы корня ' +
        'вида /../../etc/passwd nginx нормализует сам и отвечает 400 — это видно в журнале и не требует мер.',
      commands: [
        ['sudo tail -20 /var/log/nginx/access.log', 'что именно запрашивают'],
        ['sudo grep -o \'"GET [^ ]*\' /var/log/nginx/access.log | sort | uniq -c | sort -rn | head', 'частотный список путей'],
        ['sudo grep " 200 " /var/log/nginx/access.log', 'ключевой фильтр: что сервер реально отдал'],
        ['ls -la /var/www/html', 'что лежит в веб-корне, включая скрытые файлы'],
        ['sudo mv /var/www/html/backup.sql /var/backups/', 'убрать выгрузку из публичного доступа'],
        ['location ~ /\\. { deny all; }', 'закрыть класс путей, а не отдельные файлы'],
        ['sudo nginx -t && sudo systemctl reload nginx', 'проверить и применить без простоя'],
        ['curl -s -I http://127.0.0.1/.git/config', 'проверка результата: должно быть 403']
      ],
      theory: 'web-hardening',
      pitfalls: [
        'Читать журнал целиком вместо фильтра по коду ответа: за тысячей 404 теряется единственный 200.',
        'Закрывать найденные файлы по одному: завтра выложат следующий. Закрывают класс путей правилом.',
        'Удалять находки вместо перемещения — теряются данные, нужные для разбора инцидента.',
        'Перезапускать nginx без nginx -t: ошибка в конфигурации оставит сайт недоступным.',
        'Закрыть настолько широко, что перестанет открываться сам сайт: результат проверяют запросом.'
      ]
    },

    mutations: [
      {
        name: 'выгрузка базы в веб-корне',
        brief: 'Мониторинг сообщил о скачивании с сайта srv1 файла размером несколько мегабайт\n' +
          'с адреса ' + SCAN + '. Страницы сайта столько не весят.\n\n' +
          'Выясните по журналу, что было скачано, уберите это из публичного доступа\n' +
          'и закройте возможность отдавать такие файлы впредь. Сайт должен работать.',
        setup: function (world, h) {
          leftovers(h);
          /* правило для точки уже стоит — остались архивы и выгрузки */
          var m = world.get('srv1');
          var cfg = m.vfs.read(SITE, NET.ROOTCTX);
          m.vfs.write(SITE, cfg.replace('index index.html;',
            'index index.html;\n        location ~ /\\. { deny all; }'), NET.ROOTCTX);
          m.services.reload('nginx');
          h.accessLog('srv1', [
            { ip: SCAN, path: '/.git/config', status: 403, size: 162, ua: 'scanner', ts: Date.now() - 9000 },
            { ip: SCAN, path: '/.env', status: 403, size: 162, ua: 'scanner', ts: Date.now() - 8000 },
            { ip: SCAN, path: '/backup.sql', status: 200, size: 4194304, ua: 'scanner', ts: Date.now() - 7000 },
            { ip: SCAN, path: '/dump.sql', status: 404, size: 162, ua: 'scanner', ts: Date.now() - 6000 },
            { ip: '192.168.10.30', path: '/', status: 200, size: 612, ua: 'curl/8.5.0', ts: Date.now() - 3000 }
          ]);
        },
        checks: [
          C.fileAbsent('srv1', WEB + '/backup.sql', 'Выгрузки базы нет в веб-корне'),
          C.httpStatus('attacker', '192.168.10.20', 80, '/backup.sql', 403, 'Выгрузки и архивы закрыты правилом'),
          C.httpStatus('attacker', '192.168.10.20', 80, '/.env', 403, 'Файл .env закрыт'),
          C.httpStatus('app1', '192.168.10.20', 80, '/', 200, 'Сайт работает для клиентов'),
          C.survivesReboot('srv1', [
            C.httpStatus('app1', '192.168.10.20', 80, '/', 200, 'Сайт работает для клиентов')
          ])
        ],
        solution: [
          'sudo grep " 200 " /var/log/nginx/access.log',
          'sudo tail -10 /var/log/nginx/access.log',
          'ls -la /var/www/html',
          'sudo mkdir -p /var/backups',
          'sudo mv /var/www/html/backup.sql /var/backups/backup.sql',
          'sudo chmod 600 /var/backups/backup.sql',
          DENY_DUMP,
          'sudo nginx -t',
          'sudo systemctl reload nginx',
          'curl -s -I http://127.0.0.1/',
          'ls -la /var/www/html'
        ],
        hints: [
          'Отфильтруйте журнал по успешным ответам: `sudo grep " 200 " /var/log/nginx/access.log`. ' +
            'Обратите внимание на размер ответа в конце строки — он выдаёт крупный файл.',
          'Скачана выгрузка базы /backup.sql. Правило для путей с точкой её не закрывает: имя начинается ' +
            'не с точки. Нужны две меры: убрать файл из веб-корня и закрыть по расширению — ' +
            '`location ~* \\.(sql|bak|zip|tar)$ { deny all; }`.',
          '`sudo mkdir -p /var/backups && sudo mv /var/www/html/backup.sql /var/backups/`, затем ' +
            '`sudo chmod 600 /var/backups/backup.sql`. Добавьте правило по расширению в ' + SITE + ', ' +
            'выполните `sudo nginx -t` и `sudo systemctl reload nginx`.'
        ],
        debrief: {
          why: 'Правило для путей с точкой закрывает только их: файл backup.sql под него не подпадает. ' +
            'Это типичная ситуация, когда защита выглядит настроенной, но покрывает не весь класс угроз. ' +
            'Выгрузки баз и архивы опасны тем, что содержат данные целиком, поэтому их закрывают отдельным ' +
            'правилом по расширению и, главное, вообще не держат в веб-корне. Размер ответа в журнале — ' +
            'полезный признак: многомегабайтный ответ на сайте из статических страниц всегда стоит проверить.',
          commands: [
            ['sudo grep " 200 " /var/log/nginx/access.log', 'что сервер реально отдал'],
            ['ls -la /var/www/html', 'что лежит в веб-корне'],
            ['sudo mv /var/www/html/backup.sql /var/backups/', 'убрать из публичного доступа'],
            ['location ~* \\.(sql|bak|zip|tar)$ { deny all; }', 'закрыть класс файлов по расширению'],
            ['sudo nginx -t && sudo systemctl reload nginx', 'проверить и применить']
          ],
          theory: 'web-hardening'
        }
      },
      {
        name: 'права на файлы веб-корня',
        brief: 'Аудит нашёл на srv1 небезопасные права в веб-корне: файлы сайта доступны на запись\n' +
          'всем пользователям системы. Это значит, что любой локальный процесс может подменить страницу.\n\n' +
          'Приведите права в порядок: владелец — root, группа www-data, запись только владельцу.\n' +
          'Сайт при этом должен продолжать открываться.',
        setup: function (world, h) {
          leftovers(h);
          var m = world.get('srv1');
          /* права «чтобы всё точно работало»: запись всем */
          [WEB + '/index.html', WEB + '/.env', WEB + '/backup.sql'].forEach(function (p) {
            var n = m.vfs.get(p, NET.ROOTCTX);
            if (n) { n.mode = 0o666; n.uid = 0; n.gid = 0; }
          });
          var d = m.vfs.get(WEB, NET.ROOTCTX);
          if (d) d.mode = 0o777;
          h.log('srv1', 'nginx', 'world-writable files in document root', 'warning');
        },
        checks: [
          C.modeAtMost('srv1', WEB + '/index.html', 0o644),
          C.modeAtMost('srv1', WEB, 0o755),
          C.fileAbsent('srv1', WEB + '/backup.sql', 'Выгрузки базы нет в веб-корне'),
          C.httpStatus('app1', '192.168.10.20', 80, '/', 200, 'Сайт работает для клиентов'),
          C.httpStatus('attacker', '192.168.10.20', 80, '/.env', 403, 'Файл .env закрыт'),
          C.survivesReboot('srv1', [
            C.httpStatus('app1', '192.168.10.20', 80, '/', 200, 'Сайт работает для клиентов'),
            C.modeAtMost('srv1', WEB + '/index.html', 0o644)
          ])
        ],
        solution: [
          'ls -la /var/www/html',
          'sudo find /var/www/html -perm /o+w',
          'sudo mkdir -p /var/backups',
          'sudo mv /var/www/html/backup.sql /var/backups/backup.sql',
          'sudo chmod 600 /var/backups/backup.sql',
          'sudo chown -R root:www-data /var/www/html',
          'sudo chmod 755 /var/www/html',
          'sudo chmod 644 /var/www/html/index.html',
          DENY_DOT,
          'sudo nginx -t',
          'sudo systemctl reload nginx',
          'ls -la /var/www/html',
          'curl -s -I http://127.0.0.1/'
        ],
        hints: [
          '`ls -la /var/www/html` — посмотрите на права. Найти все файлы с правом записи для всех можно ' +
            'командой `sudo find /var/www/html -perm /o+w`.',
          'Права 666 и 777 означают, что изменить страницу может любой процесс в системе. ' +
            'Правильно: каталог 755, файлы 644, владелец root, группа www-data — веб-серверу достаточно чтения. ' +
            'Заодно уберите из корня выгрузку базы и закройте пути с точкой.',
          '`sudo chown -R root:www-data /var/www/html`, `sudo chmod 755 /var/www/html`, ' +
            '`sudo chmod 644 /var/www/html/index.html`. Проверьте, что сайт открывается: ' +
            '`curl -s -I http://127.0.0.1/` должен вернуть 200 — слишком строгие права (например, 600) ' +
            'сломают отдачу страниц.'
        ],
        debrief: {
          why: 'Право записи для всех в веб-корне означает, что подменить содержимое сайта может любой ' +
            'процесс на сервере — в том числе тот, который получил минимальные права через уязвимость ' +
            'в приложении. Веб-серверу для работы нужно только чтение, поэтому рабочая схема — владелец root, ' +
            'группа www-data, права 755 на каталоги и 644 на файлы. Важна и обратная сторона: слишком строгие ' +
            'права ломают сайт. Если файл станет 600 и владельцем останется root, процесс nginx его не прочитает ' +
            'и клиент получит 403. Поэтому любое изменение прав завершают проверкой запросом.',
          commands: [
            ['ls -la /var/www/html', 'текущие права и владельцы'],
            ['sudo find /var/www/html -perm /o+w', 'все файлы с записью для всех'],
            ['sudo chown -R root:www-data /var/www/html', 'владелец и группа'],
            ['sudo chmod 755 /var/www/html && sudo chmod 644 /var/www/html/index.html', 'каталоги и файлы'],
            ['curl -s -I http://127.0.0.1/', 'проверка, что сайт читается']
          ],
          theory: 'web-hardening'
        }
      }
    ]
  });
})(window.NET);
