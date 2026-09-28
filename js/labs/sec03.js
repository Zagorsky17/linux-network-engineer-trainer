/*
 * Sec 03 — отказ в обслуживании. Оборонительная задача: удержать сервис
 * работающим под потоком запросов: включить защиту ядра от SYN-флуда и
 * ограничить источники так, чтобы легитимные клиенты не пострадали.
 */
(function (NET) {
  'use strict';
  var C = NET.checks;

  /* Сеть источников потока: 198.51.100.64/29 — это .64–.71. Адрес .200 в неё не входит. */
  var BOTNET = ['198.51.100.66', '198.51.100.67', '198.51.100.68', '198.51.100.69', '198.51.100.70'];
  var ADMIN = '198.51.100.200';
  var SYSCTL_FILE = '/etc/sysctl.d/99-tuning.conf';

  function baselineFirewall(world, h) {
    var m = world.get('srv1');
    m.fw.ufw.enabled = true;
    m.fw.ufw.defaults.incoming = 'deny';
    ['22', '80', '443'].forEach(function (p) {
      m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: p, from: 'any' });
    });
    m.services.start('ufw');
    m.services.enable('ufw');
  }

  function floodLog(h, path, count) {
    var entries = [];
    for (var i = 0; i < count; i++) {
      entries.push({ ip: BOTNET[i % BOTNET.length], path: path, status: 200, size: 612,
        ua: 'Mozilla/5.0 (compatible)', ts: Date.now() - (count - i) * 200 });
    }
    h.accessLog('srv1', entries);
  }

  NET.labs.register({
    id: 'sec03',
    track: 'security',
    title: 'Отказ в обслуживании: сервер под потоком',
    difficulty: 3,
    skills: ['security', 'tcpip', 'firewall', 'troubleshooting'],
    topology: 'campus',
    brief: 'С утра сайт на srv1 не открывается: у клиентов «соединение истекло по времени».\n' +
      'Сервер при этом жив, nginx запущен, место на диске есть, из локальной сети ssh работает.\n' +
      'В журнале ядра — предупреждения про очередь соединений.\n\n' +
      'Верните работоспособность сайта под нагрузкой и не отрежьте легитимных клиентов:\n' +
      'удалённый администратор и партнёрский сервис работают с адреса ' + ADMIN + '.',
    goal: 'Сайт (80 и 443) снова доступен клиентам, защита ядра включена постоянно, ' +
      'источники потока ограничены точечно, доступ с ' + ADMIN + ' сохранён.',

    setup: function (world, h) {
      baselineFirewall(world, h);
      /* защита ядра выключена «для производительности» — и записана в файл */
      h.writeFile('srv1', SYSCTL_FILE, [
        '# tuning profile (набор параметров от подрядчика)',
        'net.ipv4.tcp_syncookies = 0',
        'net.core.somaxconn = 1024',
        ''
      ].join('\n'));
      h.sysctl('srv1', 'net.ipv4.tcp_syncookies', 0);
      /* поток полуоткрытых соединений на 443 и поток запросов на 80 */
      h.flood('srv1', { kind: 'syn', port: 443, halfOpen: 28 });
      h.flood('srv1', { kind: 'conn', port: 80, sources: BOTNET });
      floodLog(h, '/', 40);
      h.log('srv1', 'nginx', 'worker_connections are not enough while connecting to upstream', 'warning');
    },

    keySteps: [
      { id: 'repro', title: 'Воспроизвести проблему с клиента', match: /^(connect\s+app1|nc|curl)\b/ },
      { id: 'sockets', title: 'Посмотреть состояние соединений (ss)', match: /^(sudo\s+)?ss\b/ },
      { id: 'kernel', title: 'Проверить журнал ядра', match: /(journalctl.*-k|dmesg|kern\.log)/ },
      { id: 'sysctl', title: 'Проверить параметры защиты ядра', match: /sysctl|tcp_syncookies/ },
      { id: 'sources', title: 'Найти источники потока в журнале веб-сервера', match: /(access\.log|uniq\s+-c)/ },
      { id: 'fw', title: 'Ограничить источники в firewall', match: /^(sudo\s+)?ufw\b/ }
    ],

    checks: [
      C.sysctlIs('srv1', 'net.ipv4.tcp_syncookies', '1'),
      C.fileHas('srv1', SYSCTL_FILE, 'net.ipv4.tcp_syncookies = 1'),
      C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS для клиентов'),
      C.tcpOpen('app1', '192.168.10.20', 80, 'HTTP для клиентов'),
      C.tcpOpen('attacker', '192.168.10.20', 443, 'Доступ партнёра сохранён', { srcIP: ADMIN }),
      C.tcpOpen('attacker', '192.168.10.20', 22, 'SSH администратора сохранён', { srcIP: ADMIN }),
      C.ufwActive('srv1', 'deny'),
      C.survivesReboot('srv1', [
        C.sysctlIs('srv1', 'net.ipv4.tcp_syncookies', '1'),
        C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS для клиентов')
      ])
    ],

    solution: [
      'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1',
      'systemctl status nginx',
      'sudo ss -tan state syn-recv | head -5',
      'sudo ss -s',
      'journalctl -k -n 5',
      'sysctl net.ipv4.tcp_syncookies',
      'grep -rn syncookies /etc/sysctl.conf /etc/sysctl.d/',
      "sudo sed -i 's/^net.ipv4.tcp_syncookies.*/net.ipv4.tcp_syncookies = 1/' /etc/sysctl.d/99-tuning.conf",
      'sudo sysctl --system',
      'sudo tail -5 /var/log/nginx/access.log',
      'sudo grep -o "^[0-9.]*" /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -5',
      'sudo ufw status numbered',
      'sudo ufw insert 1 deny from 198.51.100.64/29',
      'sudo ufw status numbered',
      'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1'
    ],

    hints: [
      'Сначала воспроизведите: с app1 `nc -zv 192.168.10.20 443` — таймаут или отказ? ' +
        'Таймаут значит, что пакеты уходят, а ответа нет. Дальше смотрите на сервере: ' +
        '`sudo ss -tan state syn-recv | head` и `journalctl -k -n 5`.',
      'Две разные проблемы. На 443 — очередь полуоткрытых соединений (состояние SYN-RECV): от этого ' +
        'в ядре есть штатная защита, `sysctl net.ipv4.tcp_syncookies`, и она выключена в файле ' +
        '/etc/sysctl.d/99-tuning.conf. На 80 — поток запросов с нескольких адресов: найдите их в ' +
        '/var/log/nginx/access.log частотным списком и ограничьте в ufw. ' +
        'Внимание: правило должно стоять ВЫШЕ разрешающего правила для 80/443 (`ufw status numbered`), ' +
        'иначе оно не сработает. И не заблокируйте адрес ' + ADMIN + '.',
      'Решение: 1) `sudo sed -i \'s/^net.ipv4.tcp_syncookies.*/net.ipv4.tcp_syncookies = 1/\' ' +
        '/etc/sysctl.d/99-tuning.conf` и `sudo sysctl --system`; ' +
        '2) источники потока лежат в 198.51.100.64/29 (это .64–.71, адрес .200 туда не входит) — ' +
        '`sudo ufw insert 1 deny from 198.51.100.64/29`. Проверьте `sudo ufw status numbered` ' +
        'и доступ с app1.'
    ],

    debrief: {
      why: 'Отказ в обслуживании бывает разным, и лечится он тоже по-разному. SYN-флуд заполняет очередь ' +
        'полуоткрытых соединений: сервер отвечает SYN-ACK и ждёт третий пакет, которого не будет. ' +
        'Очередь конечна, и легитимные клиенты перестают в неё попадать. Штатный ответ ядра — SYN cookies: ' +
        'состояние соединения не хранится до подтверждения, поэтому очередь не переполняется. ' +
        'Параметр включён в Ubuntu по умолчанию, и его отключение «профилем тюнинга» — типичная причина ' +
        'внезапной уязвимости. Второй тип потока — обычные запросы с ограниченного набора адресов: ' +
        'здесь помогает фильтрация источников. Ключевая тонкость — порядок правил: ufw применяет первое ' +
        'совпавшее, поэтому запрет, добавленный после разрешающего правила для 80/443, не сработает. ' +
        'Его вставляют выше командой ufw insert. И точность блокировки: маска /29 покрывает ровно ' +
        'восемь адресов источников и не задевает партнёрский адрес .200 — за это отвечает та же арифметика подсетей, ' +
        'что и в задачах по адресации.',
      commands: [
        ['nc -zv 192.168.10.20 443 (с клиента)', 'таймаут против отказа: пакеты доходят, ответа нет'],
        ['sudo ss -tan state syn-recv | head', 'очередь полуоткрытых соединений — признак SYN-флуда'],
        ['journalctl -k -n 5', 'сообщение ядра «Possible SYN flooding on port 443»'],
        ['sysctl net.ipv4.tcp_syncookies', 'включена ли штатная защита ядра'],
        ['grep -rn syncookies /etc/sysctl.conf /etc/sysctl.d/', 'откуда берётся значение при загрузке'],
        ['grep -o "^[0-9.]*" /var/log/nginx/access.log | sort | uniq -c | sort -rn | head', 'частотный список источников'],
        ['sudo ufw insert 1 deny from 198.51.100.64/29', 'запрет выше разрешающих правил'],
        ['sudo ufw status numbered', 'проверить порядок правил']
      ],
      theory: 'dos-defence',
      pitfalls: [
        'Добавить запрет командой ufw deny в конец списка: разрешающее правило для 443 сработает раньше.',
        'Заблокировать всю сеть 198.51.100.0/24 и отрезать партнёра и администратора.',
        'Включить syncookies только через sysctl -w: после перезагрузки файл вернёт 0.',
        'Перезапускать nginx по кругу: служба здесь ни при чём, переполнена очередь ядра.'
      ]
    },

    mutations: [
      {
        name: 'поток только на веб-порт',
        brief: 'Сайт на srv1 перестал открываться: у клиентов таймаут. SSH работает, сервер не загружен.\n' +
          'Журнал ядра чист, полуоткрытых соединений нет — зато access.log растёт на глазах.\n\n' +
          'Остановите поток и верните сайт клиентам. Партнёр и администратор работают с ' + ADMIN + '.',
        setup: function (world, h) {
          baselineFirewall(world, h);
          h.flood('srv1', { kind: 'conn', port: 443, sources: BOTNET });
          h.flood('srv1', { kind: 'conn', port: 80, sources: BOTNET });
          floodLog(h, '/', 60);
          h.log('srv1', 'nginx', '2 worker_connections are not enough, reusing connections', 'warning');
        },
        checks: [
          C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS для клиентов'),
          C.tcpOpen('app1', '192.168.10.20', 80, 'HTTP для клиентов'),
          C.tcpOpen('attacker', '192.168.10.20', 443, 'Доступ партнёра сохранён', { srcIP: ADMIN }),
          C.tcpOpen('attacker', '192.168.10.20', 22, 'SSH администратора сохранён', { srcIP: ADMIN }),
          C.ufwActive('srv1', 'deny')
        ],
        solution: [
          'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1',
          'sudo ss -s',
          'journalctl -k -n 3',
          'sudo tail -5 /var/log/nginx/access.log',
          'sudo grep -o "^[0-9.]*" /var/log/nginx/access.log | sort | uniq -c | sort -rn | head -5',
          'sudo ufw status numbered',
          'sudo ufw insert 1 deny from 198.51.100.64/29',
          'sudo ufw status numbered',
          'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1'
        ],
        hints: [
          'Журнал ядра чист и SYN-RECV нет — значит, соединения устанавливаются полностью. ' +
            'Это поток обычных запросов. Источники ищите в /var/log/nginx/access.log.',
          'Частотный список даёт адреса: `sudo grep -o "^[0-9.]*" /var/log/nginx/access.log | sort | uniq -c | sort -rn | head`. ' +
            'Все они лежат в диапазоне 198.51.100.64–.71, то есть в подсети /29. ' +
            'Адрес партнёра ' + ADMIN + ' в неё не входит — блокировать всю /24 нельзя.',
          'Посмотрите `sudo ufw status numbered`: разрешающие правила для 80 и 443 стоят первыми, ' +
            'поэтому запрет нужно вставить выше — `sudo ufw insert 1 deny from 198.51.100.64/29`. ' +
            'Затем проверьте доступ с app1.'
        ],
        debrief: {
          why: 'Когда соединения устанавливаются полностью, защита ядра от SYN-флуда не помогает: ' +
            'проблема не в очереди, а в том, что ограниченный набор адресов занимает все рабочие соединения службы. ' +
            'Диагноз ставится по источникам в журнале приложения, а лечение — точечная фильтрация. ' +
            'Главное здесь — арифметика подсетей и порядок правил. Маска /29 покрывает восемь адресов ' +
            '(198.51.100.64–.71) и не трогает партнёрский .200, а ufw insert 1 ставит запрет выше ' +
            'разрешающих правил, иначе он никогда не сработает.',
          commands: [
            ['sudo grep -o "^[0-9.]*" /var/log/nginx/access.log | sort | uniq -c | sort -rn | head', 'кто именно генерирует поток'],
            ['ipcalc 198.51.100.64/29', 'проверить границы подсети перед блокировкой'],
            ['sudo ufw insert 1 deny from 198.51.100.64/29', 'запрет выше разрешающих правил'],
            ['sudo ufw status numbered', 'убедиться в порядке правил']
          ],
          theory: 'dos-defence'
        }
      },
      {
        name: 'защита ядра отключена профилем тюнинга',
        brief: 'После применения «профиля производительности» сайт на srv1 стал падать под нагрузкой:\n' +
          'клиенты получают таймаут на 443, в журнале ядра — предупреждения об очереди соединений.\n\n' +
          'Верните штатную защиту так, чтобы она действовала и после перезагрузки.',
        setup: function (world, h) {
          baselineFirewall(world, h);
          h.writeFile('srv1', SYSCTL_FILE, [
            '# performance profile',
            'net.ipv4.tcp_syncookies = 0',
            'net.ipv4.tcp_max_syn_backlog = 128',
            ''
          ].join('\n'));
          h.sysctl('srv1', 'net.ipv4.tcp_syncookies', 0);
          h.flood('srv1', { kind: 'syn', port: 443, halfOpen: 32 });
        },
        checks: [
          C.sysctlIs('srv1', 'net.ipv4.tcp_syncookies', '1'),
          C.fileHas('srv1', SYSCTL_FILE, 'net.ipv4.tcp_syncookies = 1'),
          C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS для клиентов'),
          C.tcpOpen('attacker', '192.168.10.20', 443, 'Доступ партнёра сохранён', { srcIP: ADMIN }),
          C.survivesReboot('srv1', [
            C.sysctlIs('srv1', 'net.ipv4.tcp_syncookies', '1'),
            C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS для клиентов')
          ])
        ],
        solution: [
          'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1',
          'sudo ss -tan state syn-recv | head -5',
          'journalctl -k -n 5',
          'sysctl net.ipv4.tcp_syncookies',
          'grep -rn syncookies /etc/sysctl.conf /etc/sysctl.d/',
          "sudo sed -i 's/^net.ipv4.tcp_syncookies.*/net.ipv4.tcp_syncookies = 1/' /etc/sysctl.d/99-tuning.conf",
          'sudo sysctl --system',
          'sysctl net.ipv4.tcp_syncookies',
          'connect app1', 'nc -zv 192.168.10.20 443', 'connect srv1'
        ],
        hints: [
          '`sudo ss -tan state syn-recv | head` — много ли соединений застряло в этом состоянии? ' +
            'И что пишет ядро: `journalctl -k -n 5`?',
          'Очередь полуоткрытых соединений переполнена. В ядре есть штатная защита — SYN cookies. ' +
            'Проверьте `sysctl net.ipv4.tcp_syncookies`: значение 0 означает, что её отключили. ' +
            'Найдите источник: `grep -rn syncookies /etc/sysctl.conf /etc/sysctl.d/`.',
          "Исправьте файл: `sudo sed -i 's/^net.ipv4.tcp_syncookies.*/net.ipv4.tcp_syncookies = 1/' " +
            '/etc/sysctl.d/99-tuning.conf`, затем `sudo sysctl --system`. ' +
            'Одного `sysctl -w` мало: после перезагрузки файл вернёт 0.'
        ],
        debrief: {
          why: 'SYN cookies — стандартная защита ядра Linux, включённая по умолчанию. Она позволяет ' +
            'не хранить состояние полуоткрытого соединения до получения подтверждения, поэтому очередь ' +
            'не переполняется и легитимные клиенты проходят даже под потоком. «Профили тюнинга» из интернета ' +
            'нередко отключают её ради мнимой производительности — и сервер становится уязвим к простейшему ' +
            'SYN-флуду. Правило то же, что и для любого параметра ядра: проверять нужно и текущее значение ' +
            '(sysctl), и то, что будет после загрузки (файлы в /etc/sysctl.d). Расхождение между ними — ' +
            'это будущий инцидент.',
          commands: [
            ['sudo ss -tan state syn-recv | head', 'очередь полуоткрытых соединений'],
            ['journalctl -k -n 5', 'ядро прямо сообщает о SYN-флуде'],
            ['sysctl net.ipv4.tcp_syncookies', 'текущее значение'],
            ['grep -rn syncookies /etc/sysctl.d/', 'значение при загрузке'],
            ['sudo sysctl --system', 'применить файлы так же, как это сделает загрузка']
          ],
          theory: 'dos-defence'
        }
      }
    ]
  });
})(window.NET);
