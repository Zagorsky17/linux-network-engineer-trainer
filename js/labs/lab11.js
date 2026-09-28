/* Lab 11 — /etc/hosts перекрывает DNS: dig отвечает верно, а приложения идут не туда. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  NET.labs.register({
    id: 'lab11',
    title: 'Имя ведёт не туда: /etc/hosts',
    difficulty: 1,
    skills: ['dns', 'linux', 'troubleshooting', 'cli'],
    topology: 'campus',
    brief: 'С srv1 не открывается внутренний портал app1.corp.local:\n' +
      '`curl http://app1.corp.local` падает с «No route to host», `ping app1.corp.local` не отвечает.\n' +
      'При этом коллеги с других машин заходят на портал без проблем,\n' +
      'а DNS-администратор уверяет, что запись в зоне правильная.\n\n' +
      'Выясните, откуда srv1 берёт адрес для этого имени, и исправьте.',
    goal: 'На srv1 имя app1.corp.local разрешается в 192.168.10.30 и портал открывается.',

    setup: function (world, h) {
      /* «временная» запись, оставшаяся после переезда портала */
      h.appendFile('srv1', '/etc/hosts',
        '\n# портал на время миграции (удалить после переезда!)\n192.168.10.31\tapp1.corp.local app1');
    },

    keySteps: [
      { id: 'ping', title: 'Воспроизвести проблему и увидеть адрес (ping по имени)', match: /^(ping|curl)\b.*app1/ },
      { id: 'dig', title: 'Сравнить с ответом DNS (dig/host)', match: /^(dig|host|nslookup)\b/ },
      { id: 'getent', title: 'Проверить имя так, как его видит система (getent hosts)', match: /^getent\b/ },
      { id: 'hosts', title: 'Посмотреть /etc/hosts', match: /(cat|less|grep|nano|vi|head|tail).*\/etc\/hosts/ }
    ],

    checks: [
      C.resolves('srv1', 'app1.corp.local', '192.168.10.30'),
      C.tcpOpenByName('srv1', 'app1.corp.local', 80, 'HTTP к порталу по имени'),
      C.custom('В /etc/hosts на srv1 нет устаревшей записи 192.168.10.31', function (world) {
        var hosts = world.get('srv1').vfs.read('/etc/hosts', NET.ROOTCTX);
        var stale = hosts.split('\n').some(function (l) { return /^\s*192\.168\.10\.31\s/.test(l); });
        return { ok: !stale, detail: stale ? 'строка с 192.168.10.31 всё ещё в файле' : null };
      })
    ],

    solution: [
      'ping -c1 app1.corp.local',
      'dig +short app1.corp.local',
      'getent hosts app1.corp.local',
      'cat /etc/hosts',
      "sudo sed -i '/192.168.10.31/d' /etc/hosts",
      'getent hosts app1.corp.local',
      'curl -s http://app1.corp.local'
    ],

    hints: [
      'Посмотрите, в какой адрес превращается имя: первая строка `ping -c1 app1.corp.local` его показывает. ' +
        'Теперь сравните с `dig +short app1.corp.local`.',
      'dig спрашивает DNS-сервер напрямую, а ping и curl идут через системный резолвер, который сначала читает /etc/hosts. ' +
        'Проверьте `getent hosts app1.corp.local` и `cat /etc/hosts`.',
      'В /etc/hosts осталась строка `192.168.10.31 app1.corp.local app1`. Удалите её: ' +
        "`sudo sed -i '/192.168.10.31/d' /etc/hosts` (или `sudo nano /etc/hosts`)."
    ],

    debrief: {
      why: 'Системный резолвер (glibc, NSS) сначала смотрит в /etc/hosts и лишь потом спрашивает DNS — ' +
        'порядок задан строкой hosts: files dns в /etc/nsswitch.conf. Ручная запись с устаревшим адресом ' +
        'перекрывала правильную запись в зоне. dig ходит к DNS-серверу мимо /etc/hosts, поэтому показывал ' +
        '«всё в порядке» и сбивал с толку. Проверять имя «глазами приложения» нужно через getent.',
      commands: [
        ['ping -c1 app1.corp.local', 'в первой строке виден адрес, который получило приложение'],
        ['dig +short app1.corp.local', 'что отвечает DNS-сервер (без /etc/hosts)'],
        ['getent hosts app1.corp.local', 'что отвечает системный резолвер — ровно то, что видят программы'],
        ['cat /etc/hosts', 'статические записи, которые побеждают DNS'],
        ["sudo sed -i '/192.168.10.31/d' /etc/hosts", 'удалить устаревшую строку']
      ],
      theory: 'hosts-file',
      pitfalls: [
        'Верить dig как «истине для приложений»: он не читает /etc/hosts.',
        'Оставлять «временные» записи в /etc/hosts без комментария и срока — они живут годами.',
        'Чистить кеш DNS в надежде, что поможет: /etc/hosts не кешируется, он читается при каждом запросе.'
      ]
    },

    mutations: [
      {
        name: 'внешний сайт «заблокирован» в hosts',
        brief: 'С srv1 вместо сайта www.example.com открывается «Welcome to nginx!» —\n' +
          'страница-заглушка, которой у example.com быть не может.\n' +
          'С app1 сайт открывается нормально. Интернет на srv1 есть — ping 8.8.8.8 проходит.\n' +
          'Найдите причину.',
        setup: function (world, h) {
          h.appendFile('srv1', '/etc/hosts',
            '\n# block trackers (скрипт оптимизации)\n127.0.0.1\twww.example.com');
        },
        checks: [
          C.resolves('srv1', 'www.example.com', '93.184.216.34'),
          C.tcpOpenByName('srv1', 'www.example.com', 80, 'HTTP к www.example.com по имени')
        ],
        solution: [
          'curl -s --max-time 3 http://www.example.com',
          'getent hosts www.example.com',
          'dig +short www.example.com',
          'grep -n example /etc/hosts',
          "sudo sed -i '/www.example.com/d' /etc/hosts",
          'curl -s --max-time 3 http://www.example.com'
        ],
        hints: [
          'Заглушка nginx — это страница самого srv1. Куда на самом деле идёт curl? Посмотрите `getent hosts www.example.com`.',
          'Имя разрешается в 127.0.0.1 — сам srv1. Откуда такой ответ, если dig показывает 93.184.216.34?',
          "Уберите строку из /etc/hosts: `sudo sed -i '/www.example.com/d' /etc/hosts`."
        ],
        debrief: {
          why: 'Запись 127.0.0.1 www.example.com отправляла все обращения на сам сервер. На порту 80 srv1 ' +
            'отвечает локальный nginx — отсюда его страница-заглушка вместо сайта. Такие строки часто ' +
            'добавляют «блокировщики» и скрипты оптимизации. getent показывает подмену сразу.',
          commands: [
            ['getent hosts www.example.com', 'адрес, который получит приложение'],
            ['dig +short www.example.com', 'адрес из DNS для сравнения'],
            ['grep -n example /etc/hosts', 'найти подменяющую строку'],
            ["sudo sed -i '/www.example.com/d' /etc/hosts", 'удалить её']
          ],
          theory: 'hosts-file'
        }
      }
    ]
  });
})(window.NET);
