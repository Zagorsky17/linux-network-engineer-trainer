/* Lab 06 — MTU: часть соединений работает, часть зависает. */
(function (NET) {
  'use strict';
  var C = NET.checks;
  var P = NET.packet;

  function largeTransferOk(host, ip) {
    return C.custom('Передача полноразмерного пакета (DF) до ' + ip + ' проходит', function (world) {
      var m = world.get(host);
      var lr = m.net.lookupRoute(ip);
      if (!lr || !lr.iface) return { ok: false, detail: 'нет маршрута' };
      var size = Math.min(1500, lr.iface.mtu);
      var r = P.send(world, m, ip, {
        proto: 'tcp', dport: 80, sport: 45000, size: size, df: true, ct: 'ESTABLISHED'
      });
      return { ok: !!r.ok, detail: r.ok ? null : C.describe(r) };
    });
  }

  function mtuSane(host, maxMtu) {
    return C.custom('MTU на ' + host + ' согласован с путём (≤ ' + maxMtu + ')', function (world) {
      var m = world.get(host);
      var lr = m.net.lookupRoute('8.8.8.8');
      if (!lr || !lr.iface) return { ok: false, detail: 'нет маршрута наружу' };
      var mtu = lr.iface.mtu;
      if (mtu > maxMtu) return { ok: false, detail: 'сейчас ' + mtu + ' — больше, чем позволяет путь' };
      if (mtu < 1280) return { ok: false, detail: 'сейчас ' + mtu + ' — слишком мало, IPv6 требует ≥1280' };
      return { ok: true };
    });
  }

  NET.labs.register({
    id: 'lab06',
    title: 'MTU: одни соединения работают, другие зависают',
    difficulty: 4,
    skills: ['tcpip', 'troubleshooting', 'networking', 'packet'],
    topology: 'campus',
    brief: 'Жалоба: «сайт открывается наполовину и виснет».\n' +
      'С srv1 ping до 8.8.8.8 и www.example.com проходит, короткие ответы приходят,\n' +
      'но загрузка крупных страниц (`curl http://www.example.com/big`) зависает до таймаута.\n\n' +
      'Найдите причину и восстановите нормальную работу.',
    goal: 'Крупные передачи проходят: полноразмерный пакет с DF доходит до внешнего сервера.',

    setup: function (world, h) {
      var gw = world.get('gw');
      gw.net.setLink('ens34', { mtu: 1400 });
      gw.quirks.dropIcmpFragNeeded = true;   // «умный» фильтр провайдера гасит ICMP
      h.log('gw', 'kernel', 'ens34: MTU changed to 1400');
    },

    keySteps: [
      { id: 'ping-small', title: 'Проверить обычный ping', match: /^ping\b(?!.*-s)/ },
      { id: 'ping-df', title: 'Проверить MTU: ping большим пакетом с DF', match: /ping\b.*(-M\s*do|-s\s*1[0-9]{3})/ },
      { id: 'tracepath', title: 'Определить path MTU (tracepath/mtr)', match: /^(tracepath|mtr|traceroute)\b/ },
      { id: 'iface', title: 'Посмотреть MTU интерфейсов', match: /(ip\s+(-\w+\s+)*(l|link|a|addr)|ifconfig|cat\s+\/sys\/class\/net)/ },
      { id: 'curl', title: 'Воспроизвести проблему на прикладном уровне', match: /^(curl|wget)\b/ }
    ],

    checks: [
      C.canPing('srv1', '8.8.8.8', 'Обычный ICMP'),
      largeTransferOk('srv1', '93.184.216.34'),
      mtuSane('srv1', 1400),
      C.survivesReboot('srv1', [mtuSane('srv1', 1400)])
    ],

    hints: [
      'Симптом «маленькое проходит, большое зависает» — почти всегда MTU. Проверьте: ' +
        '`ping -c2 -s 1472 -M do 8.8.8.8` (1472+28 = 1500) и постепенно уменьшайте размер.',
      'Пакеты 1472 с DF пропадают молча — значит ICMP «Fragmentation needed» до нас не доходит (PMTUD сломан). ' +
        '`tracepath 8.8.8.8` покажет реальный pmtu по пути. Подберите максимальный проходящий размер: 1372+28 = 1400.',
      'Установите MTU 1400 на исходящем интерфейсе постоянно: в /etc/netplan/01-netcfg.yaml добавьте в ens33 ' +
        'строку `mtu: 1400`, затем `sudo netplan apply`. Временно — `sudo ip link set ens33 mtu 1400`.'
    ],

    debrief: {
      why: 'На участке до провайдера MTU был уменьшен до 1400, а ICMP-сообщения «Fragmentation needed and DF set» ' +
        'по пути отбрасывались. Path MTU Discovery в TCP полагается именно на эти ICMP-сообщения: без них ' +
        'клиент продолжает слать 1500-байтные сегменты, которые молча пропадают. ' +
        'Результат — рукопожатие и мелкие ответы проходят (они короткие), а передача данных зависает: ' +
        'классический MTU blackhole.',
      commands: [
        ['ping -c2 -s 1472 -M do 8.8.8.8', 'проверка прохождения полноразмерного пакета'],
        ['ping -c2 -s 1372 -M do 8.8.8.8', 'бинарный поиск рабочего размера'],
        ['tracepath 8.8.8.8', 'показывает pmtu по пути'],
        ['ip link show ens33', 'текущий MTU интерфейса'],
        ['sudo ip link set ens33 mtu 1400', 'быстрая проверка гипотезы'],
        ['sudo netplan apply', 'зафиксировать mtu: 1400 в конфигурации']
      ],
      theory: 'mtu-pmtud',
      pitfalls: [
        'Размер в ping -s — это payload: итоговый IP-пакет на 28 байт больше.',
        'MTU ниже 1280 ломает IPv6.',
        'Альтернатива на маршрутизаторе — TCP MSS clamping, но на хосте правильный путь — согласовать MTU.'
      ]
    },

    mutations: [
      {
        name: 'MTU задан неверно на самом сервере',
        brief: 'После настройки VPN на srv1 «часть сайтов открывается, часть нет».\n' +
          'ping работает, крупные передачи зависают. Разберитесь.',
        setup: function (world, h) {
          var gw = world.get('gw');
          gw.net.setLink('ens34', { mtu: 1400 });
          gw.quirks.dropIcmpFragNeeded = true;
          var m = world.get('srv1');
          m.net.setLink('ens33', { mtu: 9000 });   // «jumbo» там, где его никто не поддерживает
          h.log('srv1', 'kernel', 'ens33: MTU changed to 9000');
        },
        hints: [
          'Сравните MTU на своём интерфейсе и реальный MTU пути: `ip link show ens33` против `tracepath 8.8.8.8`.',
          'MTU 9000 имеет смысл только если его поддерживает весь путь. Здесь путь ограничен 1400.',
          '`sudo ip link set ens33 mtu 1400` и зафиксируйте `mtu: 1400` в netplan.'
        ]
      }
    ]
  });
})(window.NET);
