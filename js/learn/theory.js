/*
 * theory.js — короткие теоретические врезки.
 * Показываются только в разборе после задачи: тренажёр объясняет то,
 * во что пользователь только что упёрся, а не заменяет справочник.
 */
(function (NET) {
  'use strict';

  var cards = NET.registries.theory;

  function card(c) { cards[c.id] = c; return c; }

  card({
    id: 'routing-basics', title: 'Как ядро выбирает маршрут', skill: 'routing',
    text: [
      'Для каждого исходящего пакета ядро ищет в таблице маршрутов запись, покрывающую адрес назначения.',
      'Если подходящих несколько, выигрывает самая специфичная (самый длинный префикс), при равенстве — меньшая метрика.',
      'default (0.0.0.0/0) — маршрут «для всего остального»: он используется, когда ничего конкретнее не нашлось.',
      'Нет подходящей записи → ядро сразу отвечает «Network is unreachable», не отправляя ничего в сеть.',
      'Маршрут через шлюз требует, чтобы сам шлюз был в одной подсети с интерфейсом — иначе ARP не разрешится.'
    ].join('\n'),
    commands: ['ip route', 'ip route get <ip>', 'ip route add <net> via <gw> dev <if>']
  });

  card({
    id: 'longest-prefix-match', title: 'Longest prefix match', skill: 'routing',
    text: [
      '10.20.0.0/16 всегда побеждает default, потому что /16 длиннее /0 — даже если шлюз в этой записи нерабочий.',
      'Отсюда частый симптом: интернет работает, а одна конкретная подсеть — нет.',
      '`ip route get <ip>` избавляет от догадок: ядро само сообщает выбранный маршрут, next-hop и src-адрес.',
      'Лечение — убрать ошибочную запись или заменить её (`ip route replace`), а не добавлять ещё одну.'
    ].join('\n'),
    commands: ['ip route get 10.20.5.10', 'ip route del <net> via <gw>', 'ip route replace <net> via <gw>']
  });

  card({
    id: 'arp-and-gateway', title: 'ARP и шлюз', skill: 'networking',
    text: [
      'Чтобы отправить кадр, хосту нужен MAC следующего узла. Для этого он шлёт широковещательный ARP who-has.',
      'Если ответа нет, запись в neighbour-кэше остаётся INCOMPLETE/FAILED, а ping отвечает «Destination Host Unreachable».',
      'Это отличается от «Network is unreachable»: там маршрута нет вовсе, здесь маршрут есть, но сосед не отвечает.',
      'Два ответа на один who-has с разных MAC — конфликт IP: трафик начинает «прыгать» между хостами.'
    ].join('\n'),
    commands: ['ip neigh', 'arping -I <if> <ip>', 'tcpdump -i <if> -n -e arp']
  });

  card({
    id: 'netplan-basics', title: 'Netplan: декларативная конфигурация', skill: 'automation',
    text: [
      'Ubuntu описывает желаемое состояние сети в /etc/netplan/*.yaml, а применяет его бэкенд (networkd или NetworkManager).',
      '`netplan apply` переконфигурирует интерфейсы целиком — всё, что было сделано руками через ip, теряется.',
      '`netplan try` применяет конфигурацию с автоматическим откатом: страховка при удалённой работе.',
      'YAML требователен: только пробелы, адрес обязательно с префиксом (192.168.10.20/24).',
      'Правило: диагностируем через ip, чиним постоянно — через netplan/nmcli.'
    ].join('\n'),
    commands: ['netplan generate', 'netplan try', 'netplan apply', 'netplan status']
  });

  card({
    id: 'dns-resolution', title: 'Путь DNS-запроса', skill: 'dns',
    text: [
      'getaddrinfo сначала смотрит /etc/hosts, затем спрашивает серверы из /etc/resolv.conf (UDP/53, при усечении — TCP).',
      'В Ubuntu resolv.conf обычно указывает на 127.0.0.53 — заглушку systemd-resolved, которая уже знает upstream-серверы.',
      'Различайте ответы: NXDOMAIN — имени нет; SERVFAIL — сервер не смог ответить; таймаут — до сервера не дошло.',
      '`dig @сервер имя` проверяет конкретный сервер в обход конфигурации — это отделяет «сломан клиент» от «сломан сервер».'
    ].join('\n'),
    commands: ['dig имя +short', 'dig @8.8.8.8 имя', 'resolvectl status', 'cat /etc/resolv.conf']
  });

  card({
    id: 'dhcp-flow', title: 'Как работает DHCP', skill: 'dhcp',
    text: [
      'Обмен из четырёх шагов внутри L2-сегмента: DISCOVER (broadcast) → OFFER → REQUEST → ACK.',
      'Клиент получает не только адрес, но и маску, шлюз, DNS и время аренды.',
      'Нет OFFER — значит: нет линка/не тот VLAN, сервер не работает, либо ответ отфильтрован (udp 67/68).',
      'tcpdump port 67 or port 68 сразу показывает, уходит ли DISCOVER и приходит ли ответ.'
    ].join('\n'),
    commands: ['dhclient -v <if>', 'tcpdump -i <if> -n port 67 or port 68', 'systemctl status isc-dhcp-server']
  });

  card({
    id: 'firewall-drop-vs-reject', title: 'DROP против REJECT', skill: 'firewall',
    text: [
      'DROP молча уничтожает пакет: клиент ждёт до таймаута — симптом «висит».',
      'REJECT отвечает RST (TCP) или ICMP unreachable: клиент мгновенно получает «Connection refused».',
      'Закрытый порт (никто не слушает) тоже даёт мгновенный refused — поэтому refused ≠ firewall.',
      'Алгоритм: таймаут → ищем фильтр по пути; refused → проверяем сокет (ss) и правила REJECT.',
      'ufw, iptables и nft — три интерфейса к одному netfilter: правило видно через любой из них.'
    ].join('\n'),
    commands: ['ufw status verbose', 'iptables -L -n -v --line-numbers', 'nft list ruleset']
  });

  card({
    id: 'refused-vs-timeout', title: 'Чтение отказов TCP', skill: 'tcpip',
    text: [
      'Connection refused: пакет дошёл, хост ответил RST — сеть и фильтр в порядке, проблема в сервисе/порте.',
      'Connection timed out: ответа нет вовсе — фильтр, потеря пакетов или нет обратного маршрута.',
      'No route to host: ARP/маршрут не разрешились локально или промежуточный роутер прислал ICMP unreachable.',
      'Каждый из трёх ответов сокращает область поиска вдвое — не пропускайте этот шаг.'
    ].join('\n'),
    commands: ['nc -zv <ip> <port>', 'ss -tlnp', 'curl -v --max-time 5 <url>']
  });

  card({
    id: 'mtu-pmtud', title: 'MTU и Path MTU Discovery', skill: 'tcpip',
    text: [
      'MTU — максимальный размер IP-пакета в канале. Ethernet по умолчанию 1500.',
      'TCP определяет MTU пути по ICMP-сообщениям «Fragmentation needed and DF set» от промежуточных узлов.',
      'Если эти ICMP заблокированы, PMTUD ломается: рукопожатие проходит (пакеты мелкие), а передача данных зависает.',
      'Диагностика: ping -s <size> -M do с уменьшением размера; tracepath показывает pmtu.',
      'Помните: ping -s задаёт payload, итоговый пакет на 28 байт больше. MTU ниже 1280 ломает IPv6.'
    ].join('\n'),
    commands: ['ping -c2 -s 1472 -M do <ip>', 'tracepath <ip>', 'ip link set <if> mtu 1400']
  });

  card({
    id: 'tcp-handshake', title: 'TCP handshake в дампе', skill: 'packet',
    text: [
      'Нормальное соединение: SYN → SYN-ACK → ACK. По дампу видно, на каком шаге всё встало.',
      'SYN без ответа на сервере: пакет дошёл, но отброшен фильтром (или сервис не слушает — тогда был бы RST).',
      'SYN без ответа только на клиенте, а на сервере его нет — теряется по пути: смотрите маршрутизацию.',
      'Повторные SYN с растущими интервалами — классическая картина «висящего» соединения.'
    ].join('\n'),
    commands: ['tcpdump -i <if> -n port <port>', 'tcpdump -i <if> -n "tcp[tcpflags] & tcp-syn != 0"']
  });

  card({
    id: 'packet-capture', title: 'Как снимать дамп осмысленно', skill: 'packet',
    text: [
      'Всегда указывайте интерфейс и фильтр: без них дамп тонет в постороннем трафике.',
      'Снимайте одновременно на обеих сторонах — так сразу видно, где теряется пакет.',
      'Пустой дамп — тоже результат: значит трафик не доходит до этого интерфейса.',
      '-n отключает резолв имён (иначе tcpdump сам создаёт DNS-трафик и искажает картину).'
    ].join('\n'),
    commands: ['tcpdump -i <if> -n host <ip>', 'tcpdump -i <if> -n port <port>', 'tcpdump -i any -n arp']
  });

  card({
    id: 'bottom-up-method', title: 'Методика «снизу вверх»', skill: 'troubleshooting',
    text: [
      'Проверяйте по уровням и фиксируйте результат каждого: L1 (carrier) → L2 (ARP) → L3 (адрес, маска, маршрут) →',
      'транспорт (порт, сокет, фильтр) → приложение (сервис, логи) → имя (DNS).',
      'После каждой проверки формулируйте гипотезу и сразу её опровергайте — это быстрее, чем «менять и смотреть».',
      'Симптом подсказывает уровень: unreachable — маршрут, refused — сокет, timeout — фильтр или потери, NXDOMAIN — DNS.',
      'Меняйте по одному параметру за раз и проверяйте результат — иначе непонятно, что именно помогло.'
    ].join('\n'),
    commands: ['ip -br a', 'ip route', 'ping -c2 <gw>', 'ss -tulpn', 'journalctl -u <unit> -n 30']
  });

  card({
    id: 'layer1-carrier', title: 'Физический уровень', skill: 'networking',
    text: [
      'state DOWN означает «выключен администратором», NO-CARRIER — «нет сигнала в кабеле».',
      '`ip link set <if> up` не поможет, если нет carrier: проблема вне операционной системы.',
      'ethtool показывает Link detected и согласованную скорость — это объективные данные от драйвера.',
      '/sys/class/net/<if>/{operstate,carrier} даёт то же самое в виде файлов, удобно для скриптов.'
    ].join('\n'),
    commands: ['ip -br link', 'ethtool <if>', 'cat /sys/class/net/<if>/operstate']
  });

  card({
    id: 'sockets-and-ports', title: 'Сокеты, порты и процессы', skill: 'services',
    text: [
      'LISTEN-сокет привязан к адресу и порту: 0.0.0.0:443 доступен извне, 127.0.0.1:443 — только локально.',
      'Это частая причина «локально работает, извне нет» — проверяйте не только порт, но и адрес привязки.',
      '`ss -tulpn` требует root, чтобы показать владельца сокета.',
      'Связка «сокет → процесс → юнит → конфигурация» позволяет пройти от симптома к строке конфига.'
    ].join('\n'),
    commands: ['ss -tulpn', 'ss -tn state established', 'systemctl status <unit>']
  });

  card({
    id: 'systemd-basics', title: 'systemd: юниты и журнал', skill: 'services',
    text: [
      'start/stop управляют сейчас, enable/disable — автозапуском. Одно без другого не переживёт перезагрузку.',
      'Состояния: active, inactive, failed. failed почти всегда означает, что демон не смог стартовать — смотрите журнал.',
      '`journalctl -u <unit> -n 50` показывает причину падения; для конфигов есть проверки: sshd -t, nginx -t.',
      '`systemctl --failed` — первое, что стоит выполнить на «странно себя ведущем» сервере.'
    ].join('\n'),
    commands: ['systemctl status <unit>', 'systemctl enable --now <unit>', 'journalctl -u <unit> -n 50']
  });

  card({
    id: 'iproute2-basics', title: 'iproute2 вместо ifconfig', skill: 'cli',
    text: [
      'ip объединяет управление адресами, линками, маршрутами и ARP; ifconfig/route/arp устарели и не показывают часть состояния.',
      'Объекты сокращаются: ip a, ip l, ip r, ip n. Флаг -br даёт компактный табличный вид, -s — счётчики.',
      'Изменения через ip действуют до перезагрузки: постоянная конфигурация — в netplan или NetworkManager.'
    ].join('\n'),
    commands: ['ip -br a', 'ip -s link show <if>', 'ip neigh', 'ip route get <ip>']
  });

  card({
    id: 'pipes-and-filters', title: 'Пайплайны как инструмент диагностики', skill: 'cli',
    text: [
      'Вывод сетевых команд — это текст: grep отбирает строки, awk — поля, sort/uniq считают повторы.',
      '«Какой процесс слушает порт» или «сколько SYN пришло с адреса» — это одна строка пайплайна.',
      'Перенаправления сохраняют состояние до изменений: ip route > /tmp/before.txt — дешёвая страховка.',
      '2>&1 объединяет потоки: важно, когда ошибки нужно тоже поймать в файл.'
    ].join('\n'),
    commands: ["ip -br a | awk '{print $1, $3}'", 'ss -tulpn | grep :443', 'journalctl -u ssh | grep -i fail']
  });

  card({
    id: 'permissions', title: 'Права доступа', skill: 'security', text: [
      'Права: r=4, w=2, x=1 для владельца, группы и остальных. Для каталога x — право входить внутрь.',
      'SSH отказывается работать с закрытым ключом, доступным другим: нужно 600 на ключ и 700 на ~/.ssh.',
      'sudo даёт права на команду, su — меняет пользователя целиком; членство в группе sudo проверяется через id.'
    ].join('\n'),
    commands: ['ls -l', 'chmod 600 ~/.ssh/id_ed25519', 'id', 'sudo -l']
  });

  card({
    id: 'http-basics', title: 'Проверка HTTP-уровня', skill: 'services',
    text: [
      'curl -I делает HEAD-запрос: быстро видно код ответа и сервер, не скачивая тело.',
      'Коды ошибок curl говорят об уровне проблемы: 6 — DNS, 7 — соединение, 28 — таймаут, 35/60 — TLS.',
      '--resolve host:port:addr позволяет проверить конкретный бэкенд, обойдя DNS.'
    ].join('\n'),
    commands: ['curl -I <url>', 'curl -v --max-time 5 <url>', 'curl --resolve host:443:10.0.0.5 https://host/']
  });

  card({
    id: 'linux-fs', title: 'Где что лежит в Ubuntu', skill: 'linux',
    text: [
      '/etc — конфигурация (netplan, ssh, nginx, resolv.conf), /var/log — логи, /proc и /sys — состояние ядра.',
      '/proc/net/dev, /proc/net/arp, /sys/class/net/<if>/mtu — те же данные, что у ip, но в виде файлов.',
      'find и grep -r по /etc быстрее, чем вспоминать точный путь конфигурации.'
    ].join('\n'),
    commands: ['find /etc -name "*.yaml"', 'grep -r nameserver /etc 2>/dev/null', 'cat /sys/class/net/ens33/mtu']
  });

  card({
    id: 'processes', title: 'Процессы и сигналы', skill: 'linux',
    text: [
      'ps aux — снимок всех процессов, ps -ef — та же информация в другом формате.',
      'kill шлёт сигнал: TERM (по умолчанию) просит завершиться, KILL (-9) убивает принудительно, HUP часто перечитывает конфиг.',
      'Убитый -9 процесс сервиса переводит юнит в failed — это видно в systemctl status и журнале.'
    ].join('\n'),
    commands: ['ps aux | grep <name>', 'pgrep -a <name>', 'kill -HUP <pid>', 'systemctl status <unit>']
  });

  NET.theory = {
    get: function (id) { return cards[id] || null; },
    add: card,
    list: function () {
      return Object.keys(cards).map(function (k) { return cards[k]; });
    },
    bySkill: function (skill) {
      return NET.theory.list().filter(function (c) { return c.skill === skill; });
    }
  };
})(window.NET);
