/* Lab 10 — комплексный инцидент: несколько независимых неисправностей. */
(function (NET) {
  'use strict';
  var C = NET.checks;

  NET.labs.register({
    id: 'lab10',
    title: 'Комплексный incident: сервер недоступен',
    difficulty: 5,
    skills: ['troubleshooting', 'networking', 'routing', 'firewall', 'services', 'dns'],
    topology: 'campus',
    brief: 'Ночью «упало всё». Утром известно следующее:\n' +
      '  • с srv1 не работает интернет и не резолвятся имена;\n' +
      '  • клиенты не открывают веб-сервис srv1 (TCP/443);\n' +
      '  • администратор не может зайти на srv1 по SSH с app1.\n\n' +
      'Неисправностей несколько и они независимы. Проведите полную диагностику\n' +
      'от физического интерфейса до приложения и восстановите работу.',
    goal: 'Интернет, DNS, HTTPS и SSH на srv1 работают; конфигурация переживает перезагрузку.',

    setup: function (world, h) {
      var m = world.get('srv1');

      /* 1. потерян маршрут по умолчанию (и в конфигурации тоже) */
      h.writeNetplan('srv1', {
        network: {
          version: 2, renderer: 'networkd',
          ethernets: {
            ens33: {
              addresses: ['192.168.10.20/24'],
              nameservers: { addresses: ['192.168.10.5'], search: ['corp.local'] }
            }
          }
        }
      });
      h.applyNetplan('srv1');

      /* 2. веб-сервис не запущен */
      m.services.stop('nginx');
      m.services.disable('nginx');

      /* 3. firewall закрывает всё, кроме 80 */
      m.fw.ufw.enabled = true;
      m.fw.ufw.defaults.incoming = 'deny';
      m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 80, from: 'any' });
      m.services.start('ufw');

      h.log('srv1', 'systemd', 'nginx.service: Deactivated successfully.');
      h.log('srv1', 'ufw', 'Firewall enabled; default incoming policy: deny');
    },

    keySteps: [
      { id: 'link', title: 'Проверить интерфейс и адрес', match: /ip\s+(-\w+\s+)*(a|addr|l|link)\b/ },
      { id: 'route', title: 'Проверить маршруты', match: /ip\s+(-\w+\s+)*(r|route)\b/ },
      { id: 'ping', title: 'Проверить связность (ping/traceroute)', match: /^(ping|traceroute|tracepath|mtr)\b/ },
      { id: 'dns', title: 'Проверить DNS', match: /^(dig|host|nslookup|resolvectl)\b/ },
      { id: 'svc', title: 'Проверить сервисы (systemctl/ss)', match: /^(systemctl|ss|netstat|journalctl)\b/ },
      { id: 'fw', title: 'Проверить firewall', match: /^(sudo\s+)?(ufw|iptables|nft)\b/ },
      { id: 'client', title: 'Проверить со стороны клиента', match: /^(connect\s+app1|nc|curl|ssh)\b/ }
    ],

    checks: [
      C.canPing('srv1', '8.8.8.8', 'Интернет'),
      C.resolves('srv1', 'www.example.com', '93.184.216.34'),
      C.serviceActive('srv1', 'nginx'),
      C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента'),
      C.tcpOpen('app1', '192.168.10.20', 22, 'SSH с клиента'),
      C.survivesReboot('srv1', [
        C.defaultVia('srv1', '192.168.10.1'),
        C.serviceActive('srv1', 'nginx')
      ])
    ],

    hints: [
      'Не ищите одну причину — их несколько. Идите строго снизу вверх и фиксируйте каждый слой: ' +
        'L1/L2 (ip link, ethtool) → L3 (ip addr, ip route, ping) → DNS → сервис (systemctl, ss) → фильтр (ufw/iptables) → клиент.',
      'Слой 3: default route отсутствует — добавьте его в netplan. ' +
        'Слой сервиса: `systemctl status nginx` — юнит остановлен и снят с автозапуска. ' +
        'Слой фильтра: `sudo ufw status verbose` — разрешён только 80/tcp.',
      'Полное исправление:\n' +
        '1) в /etc/netplan/01-netcfg.yaml добавить routes: - to: default / via: 192.168.10.1, затем `sudo netplan apply`;\n' +
        '2) `sudo systemctl enable --now nginx`;\n' +
        '3) `sudo ufw allow 22/tcp` и `sudo ufw allow 443/tcp`.'
    ],

    debrief: {
      why: 'Комплексный инцидент не решается «одной командой»: каждая жалоба относится к своему уровню. ' +
        'Отсутствие default route ломает интернет и внешний DNS; остановленный юнит закрывает порт ' +
        '(клиент получает refused); политика firewall deny incoming даёт таймауты для всего, что не разрешено явно. ' +
        'Сила метода «снизу вверх» в том, что каждый слой проверяется независимо, ' +
        'и симптомы (refused против таймаута, Network unreachable против NXDOMAIN) сразу указывают уровень.',
      commands: [
        ['ip -br a && ip route', 'быстрый снимок L3'],
        ['ping -c2 192.168.10.1 && ping -c2 8.8.8.8', 'отделить локальную сеть от маршрутизации'],
        ['dig www.example.com +short', 'DNS отдельно от IP'],
        ['systemctl --failed && systemctl status nginx', 'состояние сервисов'],
        ['ss -tulpn', 'какие порты реально слушаются'],
        ['sudo ufw status verbose', 'политика и правила фильтра'],
        ['connect app1 && nc -zv 192.168.10.20 443', 'проверка глазами клиента'],
        ['sudo systemctl enable --now nginx', 'вернуть сервис и автозапуск']
      ],
      theory: 'bottom-up-method',
      pitfalls: [
        'Починив один слой, обязательно перепроверьте остальные симптомы: они могли иметь другую причину.',
        '`systemctl start` без `enable` не переживёт перезагрузку — проверка это отловит.'
      ]
    },

    mutations: [
      {
        name: 'другой набор неисправностей',
        brief: 'Инцидент повторился, но симптомы иные:\n' +
          '  • с srv1 не открываются сайты по именам, хотя по IP всё работает;\n' +
          '  • клиенты не подключаются к srv1 по SSH;\n' +
          '  • сеть филиала 10.20.0.0/16 недоступна.\n\n' +
          'Найдите и устраните все причины.',
        setup: function (world, h) {
          var m = world.get('srv1');
          m.setResolvConf([], []);
          h.writeNetplan('srv1', {
            network: {
              version: 2, renderer: 'networkd',
              ethernets: {
                ens33: {
                  addresses: ['192.168.10.20/24'],
                  routes: [{ to: 'default', via: '192.168.10.1' }]
                }
              }
            }
          });
          h.applyNetplan('srv1');
          m.services.stop('ssh');
          world.get('gw').net.delRoute({ dst: '10.20.0.0', prefix: 16 });
        },
        checks: [
          C.resolves('srv1', 'www.example.com', '93.184.216.34'),
          C.tcpOpen('app1', '192.168.10.20', 22, 'SSH с клиента'),
          C.canPing('srv1', '10.20.5.10', 'Сеть филиала'),
          C.survivesReboot('srv1', [C.resolves('srv1', 'app1.corp.local', '192.168.10.30')])
        ],
        hints: [
          'Три независимых симптома — три отдельных проверки. DNS: `cat /etc/resolv.conf`. ' +
            'SSH: `systemctl status ssh` и `ss -tlnp`. Филиал: `traceroute -n 10.20.5.10`.',
          'DNS-серверов нет вовсе; sshd остановлен; трассировка до филиала обрывается на шлюзе.',
          '1) добавить nameservers: [192.168.10.5] в netplan и `sudo netplan apply`;\n' +
            '2) `sudo systemctl enable --now ssh`;\n' +
            '3) `connect gw` и `sudo ip route add 10.20.0.0/16 via 10.99.0.2 dev ens35`.'
        ]
      }
    ]
  });
})(window.NET);
