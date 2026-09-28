/*
 * topology.js — описание виртуальной сети.
 *
 * Топология — это данные: L2-сегменты (их роль играют коммутаторы) и машины
 * с их железом, постоянной конфигурацией и сервисами. Лаборатории ломают
 * именно это состояние, а не вывод команд.
 *
 * Логическая схема campus:
 *
 *   srv1/app1/dns1 --[lan]-- gw --[transit]-- isp --[inet]-- dns8/web1/mirror
 *                             |
 *                          [transit2] -- rtr2 -- [branch] -- branch-srv
 */
(function (NET) {
  'use strict';

  function register(t) { NET.registries.topologies[t.id] = t; }

  register({
    id: 'campus',
    title: 'Кампусная сеть с выходом в интернет',
    segments: {
      lan: { name: 'LAN switch (192.168.10.0/24)', kind: 'switch' },
      transit: { name: 'Uplink к провайдеру (203.0.113.0/30)', kind: 'p2p' },
      transit2: { name: 'Линк до филиала (10.99.0.0/30)', kind: 'p2p' },
      branch: { name: 'Сеть филиала (10.20.5.0/24)', kind: 'switch' },
      inet: { name: 'Интернет', kind: 'cloud' }
    },

    machines: [
      {
        name: 'srv1', hostname: 'ubuntu', kind: 'host', shell: true, primary: true,
        user: 'user', latency: 0.3,
        ifaces: [
          { name: 'ens33', segment: 'lan' },
          { name: 'ens34', segment: 'lan' }
        ],
        netplan: {
          network: {
            version: 2, renderer: 'networkd',
            ethernets: {
              ens33: {
                addresses: ['192.168.10.20/24'],
                routes: [{ to: 'default', via: '192.168.10.1' }],
                nameservers: { addresses: ['192.168.10.5', '8.8.8.8'], search: ['corp.local'] }
              }
            }
          }
        },
        services: [
          'systemd-journald', 'systemd-networkd', 'systemd-resolved', 'rsyslog',
          'cron', 'ssh', { name: 'nginx', state: 'active' }, { name: 'ufw', state: 'inactive', enabled: false }
        ]
      },
      {
        name: 'app1', hostname: 'app1', kind: 'host', shell: true, latency: 0.3,
        ifaces: [{ name: 'ens33', segment: 'lan' }],
        netplan: {
          network: {
            version: 2, renderer: 'networkd',
            ethernets: {
              ens33: {
                addresses: ['192.168.10.30/24'],
                routes: [{ to: 'default', via: '192.168.10.1' }],
                nameservers: { addresses: ['192.168.10.5'], search: ['corp.local'] }
              }
            }
          }
        },
        services: ['systemd-journald', 'systemd-networkd', 'systemd-resolved', 'ssh', 'cron',
          { name: 'nginx', state: 'active' }, { name: 'ufw', state: 'inactive', enabled: false }]
      },
      {
        name: 'dns1', hostname: 'ns1', kind: 'server', shell: true, latency: 0.4,
        ifaces: [{ name: 'ens33', segment: 'lan', addrs: ['192.168.10.5/24'] }],
        routes: [{ dst: 'default', gw: '192.168.10.1', dev: 'ens33', proto: 'static', metric: 100 }],
        services: ['systemd-journald', 'ssh', { name: 'named', state: 'active' }],
        dns: {
          recursive: true,
          forwarders: ['8.8.8.8'],
          zones: {
            'corp.local': {
              records: [
                { name: '@', type: 'SOA', value: 'ns1.corp.local. root.corp.local. 3 604800 86400 2419200 604800' },
                { name: '@', type: 'NS', value: 'ns1.corp.local.' },
                { name: 'ns1', type: 'A', value: '192.168.10.5' },
                { name: 'srv1', type: 'A', value: '192.168.10.20' },
                { name: 'app1', type: 'A', value: '192.168.10.30' },
                { name: 'gw', type: 'A', value: '192.168.10.1' },
                { name: 'www', type: 'CNAME', value: 'app1.corp.local' },
                { name: 'branch', type: 'A', value: '10.20.5.10' }
              ]
            },
            '10.168.192.in-addr.arpa': {
              records: [
                { name: '20', type: 'PTR', value: 'srv1.corp.local.' },
                { name: '30', type: 'PTR', value: 'app1.corp.local.' },
                { name: '1', type: 'PTR', value: 'gw.corp.local.' },
                { name: '5', type: 'PTR', value: 'ns1.corp.local.' }
              ]
            }
          }
        }
      },
      {
        name: 'gw', hostname: 'gw', kind: 'router', router: true, shell: true, latency: 0.8,
        ifaces: [
          { name: 'ens33', segment: 'lan', addrs: ['192.168.10.1/24'] },
          { name: 'ens34', segment: 'transit', addrs: ['203.0.113.2/30'] },
          { name: 'ens35', segment: 'transit2', addrs: ['10.99.0.1/30'] }
        ],
        routes: [
          { dst: 'default', gw: '203.0.113.1', dev: 'ens34', proto: 'static', metric: 100 },
          { dst: '10.20.0.0', prefix: 16, gw: '10.99.0.2', dev: 'ens35', proto: 'static', metric: 100 }
        ],
        sysctl: { 'net.ipv4.ip_forward': '1' },
        services: ['systemd-journald', 'ssh', { name: 'isc-dhcp-server', state: 'active' }],
        dhcp: {
          enabled: true, subnet: '192.168.10.0/24', prefix: 24,
          pool: { start: '192.168.10.100', end: '192.168.10.150' },
          router: '192.168.10.1', dns: ['192.168.10.5', '8.8.8.8'], domain: 'corp.local',
          leaseTime: 600, leases: {}
        }
      },
      {
        name: 'isp', hostname: 'isp-edge', kind: 'router', router: true, shell: false, latency: 4,
        ifaces: [
          { name: 'eth0', segment: 'transit', addrs: ['203.0.113.1/30'] },
          {
            name: 'eth1', segment: 'inet',
            addrs: ['8.8.8.1/24', '93.184.216.1/24', '185.125.190.1/24', '1.1.1.1/24', '142.250.185.1/24',
              '198.51.100.1/24']
          }
        ],
        routes: [{ dst: '192.168.10.0', prefix: 24, gw: '203.0.113.2', dev: 'eth0', proto: 'static' }],
        sysctl: { 'net.ipv4.ip_forward': '1' },
        services: []
      },
      {
        name: 'dns8', hostname: 'dns.google', kind: 'server', shell: false, latency: 12,
        ifaces: [{ name: 'eth0', segment: 'inet', addrs: ['8.8.8.8/24'] }],
        routes: [{ dst: 'default', gw: '8.8.8.1', dev: 'eth0', proto: 'static' }],
        services: [{ name: 'named', state: 'active' }],
        dns: {
          recursive: true, forwarders: [],
          zones: {
            'example.com': {
              records: [
                { name: '@', type: 'SOA', value: 'ns.example.com. hostmaster.example.com. 2024 7200 900 1209600 86400' },
                { name: '@', type: 'A', value: '93.184.216.34' },
                { name: 'www', type: 'A', value: '93.184.216.34' },
                { name: 'www', type: 'AAAA', value: '2606:2800:220:1:248:1893:25c8:1946' },
                { name: '@', type: 'MX', value: '10 mail.example.com.' },
                { name: 'mail', type: 'A', value: '93.184.216.35' }
              ]
            },
            'ubuntu.com': {
              records: [
                { name: '@', type: 'A', value: '185.125.190.20' },
                { name: 'archive', type: 'A', value: '185.125.190.39' },
                { name: 'security', type: 'A', value: '185.125.190.39' }
              ]
            },
            'google.com': {
              records: [
                { name: '@', type: 'A', value: '142.250.185.78' },
                { name: 'www', type: 'A', value: '142.250.185.78' },
                { name: 'dns', type: 'A', value: '8.8.8.8' }
              ]
            },
            '8.8.8.in-addr.arpa': { records: [{ name: '8', type: 'PTR', value: 'dns.google.' }] },
            '216.184.93.in-addr.arpa': { records: [{ name: '34', type: 'PTR', value: 'www.example.com.' }] }
          }
        }
      },
      {
        name: 'web1', hostname: 'www.example.com', kind: 'server', shell: false, latency: 14,
        ifaces: [{ name: 'eth0', segment: 'inet', addrs: ['93.184.216.34/24'] }],
        routes: [{ dst: 'default', gw: '93.184.216.1', dev: 'eth0', proto: 'static' }],
        services: [{ name: 'nginx', state: 'active' }],
        http: {
          '/': { status: 200, body: '<!DOCTYPE html>\n<html><head><title>Example Domain</title></head>\n<body><h1>Example Domain</h1>\n<p>This domain is for use in illustrative examples.</p>\n</body></html>\n' },
          '/big': { status: 200, size: 65536, body: '[65536 bytes of payload]\n' }
        }
      },
      {
        name: 'mirror', hostname: 'archive.ubuntu.com', kind: 'server', shell: false, latency: 18,
        ifaces: [{ name: 'eth0', segment: 'inet', addrs: ['185.125.190.39/24'] }],
        routes: [{ dst: 'default', gw: '185.125.190.1', dev: 'eth0', proto: 'static' }],
        services: [{ name: 'nginx', state: 'active' }],
        http: {
          '/': { status: 200, body: 'Ubuntu archive mirror\n' },
          '/ubuntu/dists/noble/Release': { status: 200, body: 'Origin: Ubuntu\nSuite: noble\nCodename: noble\n' }
        }
      },
      /*
       * Внешний нарушитель для раздела «Безопасность»: одна машина с набором
       * адресов 198.51.100.0/24 играет и сканер, и ботнет, и C2-сервер.
       * .200 — «удалённый администратор», легитимный клиент из интернета.
       * Консоли нет: атаки запускают сценарии лабораторий (lab.attack).
       */
      {
        name: 'attacker', hostname: 'unknown-host', kind: 'host', shell: false, latency: 22,
        ifaces: [{
          name: 'eth0', segment: 'inet',
          addrs: ['198.51.100.66/24', '198.51.100.67/24', '198.51.100.68/24', '198.51.100.69/24',
            '198.51.100.70/24', '198.51.100.77/24', '198.51.100.200/24']
        }],
        routes: [{ dst: 'default', gw: '198.51.100.1', dev: 'eth0', proto: 'static' }],
        services: [{ name: 'nginx', state: 'active' }, 'ssh'],
        http: { '/': { status: 200, body: 'ok\n' } }
      },
      {
        name: 'rtr2', hostname: 'branch-rtr', kind: 'router', router: true, shell: false, latency: 1.2,
        ifaces: [
          { name: 'eth0', segment: 'transit2', addrs: ['10.99.0.2/30'] },
          { name: 'eth1', segment: 'branch', addrs: ['10.20.5.1/24'] }
        ],
        routes: [{ dst: 'default', gw: '10.99.0.1', dev: 'eth0', proto: 'static' }],
        sysctl: { 'net.ipv4.ip_forward': '1' },
        services: []
      },
      {
        name: 'branch-srv', hostname: 'branch-srv', kind: 'host', shell: true, latency: 1.4,
        ifaces: [{ name: 'ens33', segment: 'branch', addrs: ['10.20.5.10/24'] }],
        routes: [{ dst: 'default', gw: '10.20.5.1', dev: 'ens33', proto: 'static', metric: 100 }],
        services: ['systemd-journald', 'ssh', { name: 'nginx', state: 'active' }]
      }
    ],

    /* Раскладка для SVG-схемы в UI */
    diagram: {
      nodes: [
        { id: 'srv1', label: 'srv1\n192.168.10.20', x: 60, y: 40, w: 120, h: 44, role: 'host' },
        { id: 'app1', label: 'app1\n192.168.10.30', x: 60, y: 110, w: 120, h: 44, role: 'host' },
        { id: 'dns1', label: 'ns1\n192.168.10.5', x: 60, y: 180, w: 120, h: 44, role: 'dns' },
        { id: 'lan', label: 'switch LAN', x: 230, y: 110, w: 92, h: 44, role: 'switch' },
        { id: 'gw', label: 'gw\n192.168.10.1', x: 372, y: 110, w: 120, h: 44, role: 'router' },
        { id: 'isp', label: 'isp\n203.0.113.1', x: 372, y: 32, w: 120, h: 40, role: 'router' },
        { id: 'inet', label: 'Internet', x: 372, y: -36, w: 120, h: 40, role: 'cloud' },
        { id: 'dns8', label: '8.8.8.8', x: 250, y: -104, w: 90, h: 36, role: 'dns' },
        { id: 'web1', label: 'web 93.184.216.34', x: 360, y: -104, w: 150, h: 36, role: 'server' },
        { id: 'rtr2', label: 'rtr2\n10.99.0.2', x: 372, y: 196, w: 120, h: 40, role: 'router' },
        { id: 'branch-srv', label: 'branch-srv\n10.20.5.10', x: 372, y: 262, w: 120, h: 40, role: 'host' },
        { id: 'attacker', label: 'нарушитель\n198.51.100.0/24', x: 530, y: -104, w: 130, h: 36, role: 'attacker' }
      ],
      links: [
        { from: 'srv1', to: 'lan', seg: 'lan' },
        { from: 'app1', to: 'lan', seg: 'lan' },
        { from: 'dns1', to: 'lan', seg: 'lan' },
        { from: 'lan', to: 'gw', seg: 'lan' },
        { from: 'gw', to: 'isp', seg: 'transit' },
        { from: 'isp', to: 'inet', seg: 'inet' },
        { from: 'inet', to: 'dns8', seg: 'inet' },
        { from: 'inet', to: 'web1', seg: 'inet' },
        { from: 'inet', to: 'attacker', seg: 'inet' },
        { from: 'gw', to: 'rtr2', seg: 'transit2' },
        { from: 'rtr2', to: 'branch-srv', seg: 'branch' }
      ]
    }
  });

  NET.topology = {
    get: function (id) { return NET.registries.topologies[id] || null; },
    list: function () {
      return Object.keys(NET.registries.topologies).map(function (k) {
        return NET.registries.topologies[k];
      });
    }
  };
})(window.NET);
