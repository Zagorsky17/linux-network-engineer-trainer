/* Lab 05 — сервис работает, но клиент не может подключиться к TCP/443. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  var checks = [
    C.serviceActive('srv1', 'nginx'),
    C.portListening('srv1', 443, 'tcp'),
    C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента'),
    C.tcpOpen('app1', '192.168.10.20', 22, 'SSH не должен пострадать')
  ];

  var keySteps = [
    { id: 'listen', title: 'Проверить, слушается ли порт (ss -tulpn)', match: /^(ss|netstat)\b/ },
    { id: 'local', title: 'Проверить сервис локально (curl/nc на localhost)', match: /^(curl|nc|telnet|wget)\b.*(127\.0\.0\.1|localhost)/ },
    { id: 'remote', title: 'Проверить доступ со стороны клиента', match: /^(connect\s+app1|curl|nc|telnet)\b/ },
    { id: 'fw', title: 'Посмотреть правила firewall', match: /^(sudo\s+)?(ufw|iptables|nft)\b/ }
  ];

  NET.labs.register({
    id: 'lab05',
    title: 'Firewall: клиент не подключается к 443',
    difficulty: 3,
    skills: ['firewall', 'security', 'troubleshooting', 'services'],
    topology: 'campus',
    brief: 'Веб-сервис на srv1 запущен и работает: локально `curl https://127.0.0.1` отдаёт страницу.\n' +
      'Но с клиента app1 (192.168.10.30) подключение к TCP/443 не проходит — соединение просто «висит».\n\n' +
      'Найдите причину и откройте доступ, не ломая SSH.',
    goal: 'app1 подключается к 192.168.10.20:443, доступ по SSH сохранён.',

    setup: function (world, h) {
      var m = world.get('srv1');
      m.fw.ufw.enabled = true;
      m.fw.ufw.defaults.incoming = 'deny';
      m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 22, from: 'any' });
      m.services.start('ufw');
      h.log('srv1', 'ufw', 'Firewall enabled; default incoming policy: deny');
    },

    keySteps: keySteps,
    checks: checks,

    hints: [
      'Разделите «сервис не работает» и «трафик не доходит»: сначала `ss -tulpn | grep 443` и локальный `curl -I https://127.0.0.1` ' +
        'на srv1, затем `connect app1` и оттуда `nc -zv 192.168.10.20 443`.',
      'Локально всё отвечает, извне — таймаут (а не «connection refused»). Таймаут почти всегда означает, ' +
        'что пакет молча отброшен фильтром: посмотрите `sudo ufw status verbose` и `sudo iptables -L -n`.',
      'ufw включён с политикой deny incoming и разрешением только для 22/tcp. Откройте порт: ' +
        '`sudo ufw allow 443/tcp` (или точнее: `sudo ufw allow from 192.168.10.0/24 to any port 443 proto tcp`).'
    ],

    debrief: {
      why: 'Сервис слушал 0.0.0.0:443 и был полностью исправен — проблема находилась на пути пакета. ' +
        'Ключ к диагностике: DROP даёт таймаут, а REJECT и закрытый порт — немедленный «Connection refused». ' +
        'По характеру отказа можно с высокой вероятностью назвать причину ещё до просмотра правил.',
      commands: [
        ['ss -tulpn | grep 443', 'сервис слушает и на каком адресе'],
        ['curl -I --max-time 3 https://127.0.0.1', 'проверка сервиса без участия сети'],
        ['connect app1 && nc -zv 192.168.10.20 443', 'проверка со стороны клиента'],
        ['sudo ufw status numbered', 'действующие правила'],
        ['sudo ufw allow 443/tcp', 'открыть порт'],
        ['sudo tcpdump -i ens33 -n port 443', 'видно SYN без ответа — подтверждение DROP']
      ],
      theory: 'firewall-drop-vs-reject',
      pitfalls: [
        'Никогда не закрывайте 22/tcp, работая удалённо: `ufw allow OpenSSH` перед `ufw enable`.',
        'ufw, iptables и nft — фронтенды одного netfilter: правила видны через все три.'
      ]
    },

    mutations: [
      {
        name: 'REJECT вместо DROP',
        brief: 'Клиент app1 при подключении к srv1:443 мгновенно получает «Connection refused»,\n' +
          'хотя nginx на srv1 запущен и слушает порт. Разберитесь и восстановите доступ.',
        setup: function (world, h) {
          var m = world.get('srv1');
          m.fw.addRule('INPUT', { proto: 'tcp', dport: 443, target: 'REJECT', comment: 'block-https' }, {});
        },
        hints: [
          'Мгновенный refused означает, что кто-то активно отвечает RST/ICMP: либо порт закрыт, либо правило REJECT.',
          '`ss -ltn | grep 443` показывает LISTEN — значит порт открыт, и дело в фильтре: `sudo iptables -L INPUT -n --line-numbers`.',
          'Удалите правило: `sudo iptables -D INPUT <номер>` (или `sudo iptables -D INPUT -p tcp --dport 443 -j REJECT`).'
        ]
      },
      {
        name: 'разрешено не для той подсети',
        brief: 'На srv1 «порт открыт, правило есть», но клиент 192.168.10.30 всё равно не подключается к 443.\n' +
          'Найдите и исправьте причину.',
        setup: function (world, h) {
          var m = world.get('srv1');
          m.fw.ufw.enabled = true;
          m.fw.ufw.defaults.incoming = 'deny';
          m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 22, from: 'any' });
          m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 443, from: '192.168.20.0/24' });
          m.services.start('ufw');
        },
        hints: [
          'Правило для 443 действительно есть — посмотрите внимательно столбец From: `sudo ufw status numbered`.',
          'Разрешение выдано подсети 192.168.20.0/24, а клиент находится в 192.168.10.0/24.',
          'Исправьте: `sudo ufw delete <номер>` и `sudo ufw allow from 192.168.10.0/24 to any port 443 proto tcp`.'
        ]
      }
    ]
  });
})(window.NET);
