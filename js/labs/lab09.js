/* Lab 09 — анализ трафика: причина видна только в дампе. */
(function (NET) {
  'use strict';
  var C = NET.checks;
  var P = NET.packet;

  /* Генерируем реальный трафик инцидента, чтобы в буфере было что смотреть. */
  function generateTraffic(world, tries) {
    var app1 = world.get('app1');
    for (var i = 0; i < (tries || 3); i++) {
      P.tcpConnect(world, app1, '192.168.10.20', 443, {});
    }
    P.icmpEcho(world, app1, '192.168.10.20', { size: 56 });
  }

  NET.labs.register({
    id: 'lab09',
    title: 'Packet analysis: найди проблему по трафику',
    difficulty: 4,
    skills: ['packet', 'troubleshooting', 'tcpip', 'firewall'],
    topology: 'campus',
    brief: 'Клиент app1 не может подключиться к srv1:443 — соединение «висит» и отваливается по таймауту.\n' +
      'При этом ping между хостами проходит, nginx на srv1 запущен и слушает порт.\n\n' +
      'Владелец сервиса утверждает, что «на сервере ничего не меняли».\n' +
      'Разберитесь по трафику: где теряются пакеты — и устраните причину.',
    goal: 'Определить точку потери по дампу (tcpdump) и восстановить подключение к 443.',

    setup: function (world, h) {
      var m = world.get('srv1');
      m.fw.addRule('INPUT', { proto: 'tcp', dport: 443, target: 'DROP', comment: 'audit-temp' }, {});
      generateTraffic(world, 3);
      h.log('srv1', 'kernel', 'netfilter: rule loaded from /etc/iptables/rules.v4');
    },

    keySteps: [
      { id: 'repro', title: 'Воспроизвести проблему с клиента', match: /^(connect\s+app1|curl|nc|telnet|ssh)\b/ },
      { id: 'dump-srv', title: 'Снять дамп на сервере (tcpdump port 443)', match: /tcpdump[^|]*\b443\b/ },
      { id: 'dump-any', title: 'Посмотреть трафик в принципе (tcpdump)', match: /^(sudo\s+)?tcpdump\b/ },
      { id: 'listen', title: 'Проверить слушающий сокет', match: /^(ss|netstat)\b/ },
      { id: 'fw', title: 'Проверить правила фильтра', match: /^(sudo\s+)?(iptables|nft|ufw)\b/ }
    ],

    checks: [
      C.usedCommand(/tcpdump/, 'Проведён анализ трафика (tcpdump)'),
      C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента'),
      C.portListening('srv1', 443, 'tcp')
    ],

    hints: [
      'Сначала воспроизведите: `connect app1`, `nc -zv 192.168.10.20 443` (зависает). ' +
        'Затем на srv1 снимите дамп: `sudo tcpdump -i ens33 -n port 443` и повторите попытку с клиента.',
      'В дампе на сервере видно приходящие SYN и ни одного ответного SYN-ACK. ' +
        'Пакеты доходят до хоста, но приложение их не видит — значит их отбрасывает netfilter (DROP, поэтому таймаут, а не RST).',
      'Найдите и удалите правило: `sudo iptables -L INPUT -n --line-numbers`, затем ' +
        '`sudo iptables -D INPUT <номер>` (правило -p tcp --dport 443 -j DROP).'
    ],

    debrief: {
      why: 'Дамп отвечает на вопрос, на который не отвечают ss и логи: «дошёл ли пакет и что было в ответ». ' +
        'Односторонний трафик (SYN есть, SYN-ACK нет) при работающем слушающем сокете однозначно указывает ' +
        'на фильтрацию на самом хосте. Если бы порт был закрыт, вы увидели бы RST; если бы пакет не доходил вовсе — ' +
        'дамп на сервере был бы пуст, и искать надо было бы по пути.',
      commands: [
        ['sudo tcpdump -i ens33 -n port 443', 'ключевой шаг: что реально приходит и что уходит'],
        ['sudo tcpdump -i ens33 -n "tcp[tcpflags] & tcp-syn != 0"', 'только SYN — видно попытки установить соединение'],
        ['ss -tlnp | grep 443', 'сокет слушает — приложение не виновато'],
        ['sudo iptables -L INPUT -n --line-numbers', 'найти правило'],
        ['sudo iptables -D INPUT 1', 'удалить его']
      ],
      theory: 'tcp-handshake',
      pitfalls: [
        'Снимайте дамп на обеих сторонах: это сразу показывает, теряется пакет «до» или «после» узла.',
        'Отсутствие пакетов в дампе — такой же результат, как их наличие: значит, трафик не доходит до интерфейса.'
      ]
    },

    mutations: [
      {
        name: 'конфликт IP-адресов',
        brief: 'Связь с srv1 (192.168.10.20) работает «через раз»: то ping проходит, то нет,\n' +
          'SSH-сессии рвутся. В логах сервера ничего необычного.\n\n' +
          'Разберитесь по трафику и ARP, что происходит в сегменте, и устраните причину.',
        setup: function (world, h) {
          var app1 = world.get('app1');
          app1.net.addAddr('ens33', '192.168.10.20/24', {});
          P.icmpEcho(world, world.get('dns1'), '192.168.10.20', { size: 56 });
          h.log('srv1', 'kernel', 'ens33: IPv4 address conflict detected for 192.168.10.20');
        },
        keySteps: [
          { id: 'arp', title: 'Посмотреть ARP-таблицу', match: /^(ip\s+(n|neigh)|arp)\b/ },
          { id: 'arping', title: 'Проверить адрес через arping', match: /^(sudo\s+)?arping\b/ },
          { id: 'dump', title: 'Посмотреть ARP в дампе', match: /tcpdump[^|]*arp/ },
          { id: 'addrs', title: 'Сверить адреса на хостах', match: /ip\s+(-\w+\s+)*(a|addr)/ }
        ],
        checks: [
          C.custom('В сегменте только один владелец адреса 192.168.10.20', function (world) {
            var srv1 = world.get('srv1');
            var iface = srv1.net.getIface('ens33');
            var seg = P.effSegment(srv1, iface);
            var owners = P.ownersOnSegment(world, seg, '192.168.10.20', null);
            return {
              ok: owners.length === 1,
              detail: owners.length === 1 ? null : 'владельцев: ' + owners.map(function (o) { return o.machine.name; }).join(', ')
            };
          }),
          C.canPing('dns1', '192.168.10.20', 'Связь с сервером'),
          C.usedCommand(/(arping|tcpdump[^|]*arp|ip\s+n)/, 'Использована ARP-диагностика')
        ],
        hints: [
          'Нестабильная связь с одним адресом при нормальной работе сети — характерный признак конфликта IP. ' +
            'Смотрите ARP: `ip neigh` и `sudo arping -I ens33 192.168.10.20` с третьего хоста.',
          'arping получает ответы с двух разных MAC-адресов — адрес занят двумя хостами. ' +
            'Найдите второй: сравните MAC с `ip link` на app1 и srv1.',
          'Лишний адрес настроен на app1: `connect app1`, затем `sudo ip addr del 192.168.10.20/24 dev ens33`.'
        ],
        debrief: {
          why: 'Два хоста с одним IP в одном broadcast-домене «перетягивают» ARP-кэш соседей: ' +
            'часть трафика уходит на один MAC, часть — на другой. Отсюда «работает через раз» и рвущиеся сессии. ' +
            'Ни ping, ни ss этого не показывают — диагноз ставится по ARP (arping/tcpdump arp), ' +
            'где видно несколько ответов на один who-has.',
          commands: [
            ['ip neigh', 'нестабильная или меняющаяся запись для адреса'],
            ['sudo arping -I ens33 192.168.10.20', 'два ответа с разных MAC — конфликт'],
            ['sudo tcpdump -i ens33 -n -e arp', 'видно ARP-ответы от двух MAC'],
            ['sudo ip addr del 192.168.10.20/24 dev ens33', 'убрать дублирующий адрес']
          ],
          theory: 'arp-and-gateway'
        }
      }
    ]
  });
})(window.NET);
