/* Lab 08 — не подключиться по SSH. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  NET.labs.register({
    id: 'lab08',
    title: 'SSH: невозможно подключиться',
    difficulty: 3,
    skills: ['security', 'services', 'troubleshooting', 'linux'],
    topology: 'campus',
    brief: 'Администратор не может подключиться к srv1 по SSH с клиента app1:\n' +
      '«ssh: connect to host 192.168.10.20 port 22: Connection refused».\n' +
      'Консольный доступ к серверу у вас есть.\n\n' +
      'Найдите причину и восстановите доступ по стандартному порту 22.',
    goal: 'С app1 проходит подключение к 192.168.10.20:22, настройка сохраняется после перезагрузки.',

    setup: function (world, h) {
      var m = world.get('srv1');
      var conf = m.vfs.read('/etc/ssh/sshd_config', NET.ROOTCTX)
        .replace(/^Port 22$/m, 'Port 2222');
      m.vfs.write('/etc/ssh/sshd_config', conf, NET.ROOTCTX);
      m.services.restart('ssh');
      h.log('srv1', 'sshd', 'Server listening on 0.0.0.0 port 2222.');
    },

    keySteps: [
      { id: 'client', title: 'Воспроизвести проблему с клиента', match: /^(connect\s+app1|ssh|nc|telnet)\b/ },
      { id: 'listen', title: 'Проверить слушающие сокеты на сервере', match: /^(ss|netstat)\b/ },
      { id: 'service', title: 'Проверить состояние sshd', match: /(systemctl\s+(status|is-active|restart|start)|journalctl)/ },
      { id: 'config', title: 'Посмотреть /etc/ssh/sshd_config', match: /(cat|grep|less|nano|vi|sed).*sshd_config/ }
    ],

    checks: [
      C.serviceActive('srv1', 'ssh'),
      C.portListening('srv1', 22, 'tcp'),
      C.tcpOpen('app1', '192.168.10.20', 22, 'SSH с клиента'),
      C.survivesReboot('srv1', [C.portListening('srv1', 22, 'tcp')])
    ],

    hints: [
      '«Connection refused» приходит мгновенно — значит, пакет дошёл, но никто не слушает порт (или REJECT). ' +
        'Проверьте: `ss -tlnp | grep ssh`.',
      'Демон запущен, но слушает не 22. Источник истины — конфигурация: `grep -n "^Port" /etc/ssh/sshd_config`.',
      'Верните `Port 22` в /etc/ssh/sshd_config, проверьте синтаксис `sudo sshd -t` и перезапустите: ' +
        '`sudo systemctl restart ssh`. Затем убедитесь: `ss -tlnp | grep :22`.'
    ],

    debrief: {
      why: 'Connection refused означает, что TCP-пакет дошёл до хоста и получил RST: сеть и firewall в порядке, ' +
        'а вот слушающего сокета на порту нет. Это сразу отсекает половину гипотез. ' +
        'Далее работает цепочка «сокет → процесс → юнит → конфигурация»: ss показывает реальность, ' +
        'sshd_config — намерение, systemctl связывает их.',
      commands: [
        ['ss -tlnp | grep ssh', 'на каком порту и адресе реально слушает демон'],
        ['grep -n "^Port" /etc/ssh/sshd_config', 'источник истины для порта'],
        ['sudo sshd -t', 'проверка синтаксиса перед перезапуском — иначе можно потерять доступ'],
        ['sudo systemctl restart ssh', 'применить конфигурацию'],
        ['journalctl -u ssh -n 20', 'подтверждение в логах: Server listening on 0.0.0.0 port 22']
      ],
      theory: 'refused-vs-timeout',
      pitfalls: [
        'Меняя порт SSH удалённо, сначала откройте новый порт в firewall и не закрывайте старую сессию.',
        '`sshd -t` обязателен: синтаксическая ошибка не даст демону подняться.'
      ]
    },

    mutations: [
      {
        name: 'sshd не стартует из-за ошибки конфигурации',
        brief: 'После правки конфигурации SSH на srv1 подключение перестало работать.\n' +
          'Разберитесь, почему, и восстановите доступ.',
        setup: function (world, h) {
          var m = world.get('srv1');
          var conf = m.vfs.read('/etc/ssh/sshd_config', NET.ROOTCTX)
            .replace(/^Port 22$/m, 'Port');
          m.vfs.write('/etc/ssh/sshd_config', conf, NET.ROOTCTX);
          m.services.stop('ssh');
          m.services.get('ssh').state = 'failed';
          m.services.get('ssh').result = 'exit-code';
          h.log('srv1', 'sshd', '/etc/ssh/sshd_config line 4: Missing argument.', 'err');
          h.log('srv1', 'systemd', 'ssh.service: Failed with result \'exit-code\'.', 'err');
        },
        hints: [
          '`systemctl status ssh` — юнит в состоянии failed. Что говорит журнал: `journalctl -u ssh -n 20`?',
          'В логе прямо указана строка конфигурации с ошибкой. Проверить можно и так: `sudo sshd -t`.',
          'Исправьте строку на `Port 22`, выполните `sudo sshd -t`, затем `sudo systemctl start ssh`.'
        ]
      },
      {
        name: 'SSH закрыт firewall для клиентской подсети',
        brief: 'С app1 подключение к srv1 по SSH зависает до таймаута (не refused).\n' +
          'На самом сервере sshd работает. Восстановите доступ для сети 192.168.10.0/24.',
        setup: function (world, h) {
          var m = world.get('srv1');
          m.fw.ufw.enabled = true;
          m.fw.ufw.defaults.incoming = 'deny';
          m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 22, from: '10.0.0.0/8' });
          m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 443, from: 'any' });
          m.services.start('ufw');
        },
        hints: [
          'Таймаут вместо refused — признак DROP. Сервис при этом слушает: убедитесь через `ss -tlnp`.',
          '`sudo ufw status numbered`: правило для 22/tcp есть, но From — не та подсеть.',
          '`sudo ufw allow from 192.168.10.0/24 to any port 22 proto tcp`.'
        ],
        checks: [
          C.serviceActive('srv1', 'ssh'),
          C.portListening('srv1', 22, 'tcp'),
          C.tcpOpen('app1', '192.168.10.20', 22, 'SSH с клиента')
        ]
      }
    ]
  });
})(window.NET);
