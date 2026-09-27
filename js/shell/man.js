/*
 * man.js — краткие man-страницы.
 * Это не справочник для чтения «по кругу»: страницы открываются в pager'е,
 * когда пользователю нужен конкретный флаг прямо в задаче.
 */
(function (NET) {
  'use strict';

  var pages = {};

  function page(name, section, title, body) {
    pages[name] = { name: name, section: section, title: title, body: body };
  }

  function fmt(name, section, title, synopsis, desc, opts, examples, seeAlso) {
    var out = [];
    out.push(name.toUpperCase() + '(' + section + ')' + '                      User Commands                      ' + name.toUpperCase() + '(' + section + ')');
    out.push('');
    out.push('NAME');
    out.push('       ' + name + ' - ' + title);
    out.push('');
    out.push('SYNOPSIS');
    synopsis.forEach(function (s) { out.push('       ' + s); });
    out.push('');
    out.push('DESCRIPTION');
    desc.forEach(function (d) { out.push('       ' + d); });
    if (opts && opts.length) {
      out.push('');
      out.push('OPTIONS');
      opts.forEach(function (o) {
        out.push('       ' + o[0]);
        out.push('              ' + o[1]);
      });
    }
    if (examples && examples.length) {
      out.push('');
      out.push('EXAMPLES');
      examples.forEach(function (e) { out.push('       ' + e); });
    }
    if (seeAlso) {
      out.push('');
      out.push('SEE ALSO');
      out.push('       ' + seeAlso);
    }
    out.push('');
    return out.join('\n');
  }

  page('ip', 8, 'show / manipulate routing, network devices, interfaces and tunnels',
    fmt('ip', 8, 'show / manipulate routing, devices, policy routing and tunnels',
      ['ip [ OPTIONS ] OBJECT { COMMAND | help }', 'OBJECT := { link | address | route | neigh | rule }'],
      ['ip — основная утилита пакета iproute2. Заменяет ifconfig, route и arp.',
        'Объекты сокращаются: ip a = ip addr, ip r = ip route, ip l = ip link, ip n = ip neigh.'],
      [['-4, -6', 'работать только с IPv4 / IPv6'],
        ['-br, -brief', 'компактный табличный вывод'],
        ['-s', 'статистика (счётчики пакетов и ошибок)'],
        ['-c', 'цветной вывод']],
      ['ip -br addr show', 'ip link set ens33 up', 'ip addr add 192.168.10.20/24 dev ens33',
        'ip route add default via 192.168.10.1 dev ens33', 'ip route get 8.8.8.8', 'ip neigh show'],
      'ip-address(8), ip-route(8), ip-link(8), netplan(5)'));

  page('ping', 8, 'send ICMP ECHO_REQUEST to network hosts',
    fmt('ping', 8, 'send ICMP ECHO_REQUEST to network hosts',
      ['ping [-c count] [-i interval] [-s packetsize] [-M do|dont] [-I iface] destination'],
      ['Проверяет доступность узла на уровне IP. Отсутствие ответа ≠ узел выключен:',
        'пакет может быть отброшен firewall\'ом или не иметь обратного маршрута.'],
      [['-c count', 'отправить count пакетов и выйти'],
        ['-s size', 'размер полезной нагрузки (по умолчанию 56 => 84 байта IP-пакета)'],
        ['-M do', 'запретить фрагментацию (бит DF) — так проверяют MTU'],
        ['-I iface|addr', 'отправлять с конкретного интерфейса/адреса'],
        ['-W sec', 'таймаут ожидания ответа'],
        ['-n', 'не резолвить имена']],
      ['ping -c 4 192.168.10.1', 'ping -c 3 -s 1472 -M do 8.8.8.8   # проверка MTU 1500'],
      'ip(8), traceroute(8), tcpdump(8)'));

  page('ss', 8, 'another utility to investigate sockets',
    fmt('ss', 8, 'investigate sockets',
      ['ss [options] [ FILTER ]'],
      ['Показывает сокеты: какие порты слушаются и какие соединения установлены.',
        'Замена netstat. Ключевой вопрос диагностики: «слушает ли сервис нужный порт и на каком адресе».'],
      [['-t', 'TCP'], ['-u', 'UDP'], ['-l', 'только LISTEN'], ['-n', 'числовые порты'],
        ['-p', 'показать процесс (нужен root)'], ['-a', 'все сокеты'], ['-s', 'сводка']],
      ['ss -tulpn', 'ss -tn state established', 'ss -ltn sport = :443'],
      'netstat(8), lsof(8)'));

  page('dig', 1, 'DNS lookup utility',
    fmt('dig', 1, 'DNS lookup utility',
      ['dig [@server] [name] [type] [+options]'],
      ['Отправляет DNS-запрос и печатает полный ответ: статус, секции ANSWER/AUTHORITY,',
        'время и сервер, который ответил. Именно по SERVER: и status: определяют причину сбоя.'],
      [['@server', 'спросить конкретный сервер, минуя /etc/resolv.conf'],
        ['+short', 'только ответ'], ['+trace', 'трассировка делегирования'],
        ['-x addr', 'обратный запрос (PTR)'], ['+tcp', 'запрос по TCP']],
      ['dig example.com', 'dig @8.8.8.8 example.com +short', 'dig -x 192.168.10.20'],
      'nslookup(1), host(1), resolvectl(1), resolv.conf(5)'));

  page('tcpdump', 8, 'dump traffic on a network',
    fmt('tcpdump', 8, 'dump traffic on a network',
      ['tcpdump [-i interface] [-n] [-c count] [-e] [-vv] [expression]'],
      ['Захват пакетов с фильтром BPF. Применяется, когда вывод команд противоречив:',
        'пакет ушёл, но ответа нет — значит проблема дальше по пути или в обратном маршруте.'],
      [['-i iface', 'интерфейс (any — все)'], ['-n', 'не резолвить имена'],
        ['-c N', 'остановиться после N пакетов'], ['-e', 'показывать MAC-адреса'],
        ['-vv', 'подробнее'], ['-A', 'печатать payload как текст']],
      ['tcpdump -i ens33 -n icmp', 'tcpdump -i ens33 -n port 443',
        'tcpdump -i ens33 -n "tcp[tcpflags] & tcp-syn != 0"', 'tcpdump -i any -n arp'],
      'pcap-filter(7), wireshark(1)'));

  page('systemctl', 1, 'Control the systemd system and service manager',
    fmt('systemctl', 1, 'control the systemd system and service manager',
      ['systemctl [OPTIONS...] COMMAND [UNIT...]'],
      ['Управление юнитами: start/stop/restart/reload, enable/disable (автозапуск),',
        'status (состояние + последние строки журнала).'],
      [['status UNIT', 'состояние, PID, последние логи'], ['is-active UNIT', 'active/inactive/failed'],
        ['enable --now UNIT', 'включить автозапуск и запустить'],
        ['list-units --type=service', 'список юнитов'], ['--failed', 'только упавшие']],
      ['systemctl status ssh', 'systemctl restart nginx', 'systemctl enable --now ssh'],
      'journalctl(1), systemd.service(5)'));

  page('journalctl', 1, 'Print log entries from the systemd journal',
    fmt('journalctl', 1, 'query the systemd journal',
      ['journalctl [OPTIONS...] [MATCHES...]'],
      ['Журнал systemd. Первое место, куда смотрят после «сервис не поднялся».'],
      [['-u UNIT', 'логи конкретного юнита'], ['-b', 'с текущей загрузки'],
        ['-p err', 'уровень не ниже error'], ['-n N', 'последние N строк'],
        ['-f', 'следить в реальном времени'], ['--since "10 min ago"', 'по времени']],
      ['journalctl -u ssh -n 50', 'journalctl -p err -b', 'journalctl -u systemd-networkd --since "5 min ago"'],
      'systemctl(1)'));

  page('netplan', 5, 'YAML network configuration abstraction for various backends',
    fmt('netplan', 5, 'конфигурация сети Ubuntu',
      ['netplan { generate | get | apply | try | status }'],
      ['Файлы /etc/netplan/*.yaml описывают желаемое состояние сети. netplan apply',
        'переконфигурирует интерфейсы: ручные ip-команды при этом теряются.',
        'netplan try откатывает конфигурацию, если её не подтвердить — защита от потери связи.'],
      [['apply', 'применить конфигурацию'], ['try', 'применить с откатом через 120 с'],
        ['generate', 'сгенерировать конфиги бэкенда, проверив синтаксис'],
        ['status', 'текущее состояние интерфейсов']],
      ['sudo netplan apply', 'sudo netplan try', 'netplan get ethernets'],
      'systemd-networkd(8), nmcli(1)'));

  page('nmcli', 1, 'command-line tool for controlling NetworkManager',
    fmt('nmcli', 1, 'управление NetworkManager из CLI',
      ['nmcli [OPTIONS] OBJECT { COMMAND | help }', 'OBJECT := { general | networking | device | connection }'],
      ['Работает с «соединениями» (профилями), а не с интерфейсами напрямую.',
        'Изменения через nmcli con mod сохраняются и переживают перезагрузку.'],
      [['dev status', 'состояние устройств'], ['con show [--active]', 'список профилей'],
        ['con mod NAME ipv4.addresses ...', 'изменить профиль'],
        ['con up/down NAME', 'поднять/опустить профиль']],
      ['nmcli dev status', 'nmcli con show', 'nmcli con mod "Wired 1" ipv4.method manual ipv4.addresses 192.168.10.20/24'],
      'NetworkManager(8), netplan(5)'));

  page('ufw', 8, 'program for managing a netfilter firewall',
    fmt('ufw', 8, 'простой фронтенд к netfilter',
      ['ufw [--dry-run] enable|disable|status|allow|deny|delete ...'],
      ['Когда ufw включён, по умолчанию входящий трафик запрещён (DROP),',
        'исходящий разрешён. DROP даёт таймаут, REJECT — connection refused: различайте.'],
      [['status verbose|numbered', 'правила и политики'], ['allow 443/tcp', 'открыть порт'],
        ['delete N', 'удалить правило по номеру'], ['default deny incoming', 'политика по умолчанию']],
      ['sudo ufw status numbered', 'sudo ufw allow from 192.168.10.0/24 to any port 22 proto tcp'],
      'iptables(8), nft(8)'));

  page('iptables', 8, 'administration tool for IPv4 packet filtering and NAT',
    fmt('iptables', 8, 'фильтрация пакетов IPv4',
      ['iptables [-t table] {-A|-I|-D|-L|-F} chain [rule-spec] [-j target]'],
      ['Цепочки INPUT (к нам), OUTPUT (от нас), FORWARD (транзит). Правила читаются',
        'сверху вниз, первое совпадение выигрывает; иначе применяется политика цепочки.'],
      [['-L -n -v --line-numbers', 'показать правила'], ['-A/-I chain', 'добавить в конец / в начало'],
        ['-D chain N', 'удалить правило'], ['-p tcp --dport 443', 'протокол и порт'],
        ['-j ACCEPT|DROP|REJECT', 'действие']],
      ['sudo iptables -L -n -v', 'sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT'],
      'nft(8), ufw(8)'));

  page('curl', 1, 'transfer a URL',
    fmt('curl', 1, 'передача данных по URL',
      ['curl [options] <url>'],
      ['Проверяет прикладной уровень. Код ошибки многое говорит: (7) failed to connect —',
        'порт закрыт/фильтруется; (6) could not resolve — DNS; (28) timed out — пакеты теряются.'],
      [['-I', 'только заголовки (HEAD)'], ['-v', 'подробный лог соединения'],
        ['-4 / -6', 'только IPv4 / IPv6'], ['--max-time N', 'общий таймаут'],
        ['-o file', 'сохранить в файл'], ['--resolve host:port:addr', 'обойти DNS']],
      ['curl -I http://app1.corp.local', 'curl -v --max-time 5 https://192.168.10.30'],
      'wget(1), ss(8)'));

  page('ssh', 1, 'OpenSSH remote login client',
    fmt('ssh', 1, 'удалённый вход по SSH',
      ['ssh [-p port] [-i identity] [-v] [user@]hostname [command]'],
      ['Порядок диагностики: TCP-доступность порта (ss/nc) → работает ли sshd →',
        'аутентификация (ключи, права на ~/.ssh) → конфигурация sshd_config.'],
      [['-v / -vvv', 'подробный лог рукопожатия'], ['-p port', 'нестандартный порт'],
        ['-i file', 'ключ'], ['-o Option=value', 'параметр конфигурации']],
      ['ssh -v user@192.168.10.30', 'ssh -p 2222 user@app1'],
      'sshd_config(5), ssh-keygen(1)'));

  page('grep', 1, 'print lines that match patterns',
    fmt('grep', 1, 'поиск строк по шаблону',
      ['grep [OPTION...] PATTERNS [FILE...]'],
      ['Основной инструмент фильтрации вывода в пайплайнах.'],
      [['-i', 'без учёта регистра'], ['-v', 'инвертировать'], ['-n', 'номера строк'],
        ['-r', 'рекурсивно'], ['-E', 'расширенные регулярные выражения'], ['-c', 'счётчик']],
      ['ip a | grep -w inet', 'journalctl -u ssh | grep -i fail'],
      'sed(1), awk(1)'));

  page('chmod', 1, 'change file mode bits',
    fmt('chmod', 1, 'изменение прав доступа',
      ['chmod [OPTION]... MODE[,MODE]... FILE...'],
      ['Права: r=4, w=2, x=1 для владельца/группы/остальных.',
        'Для каталога x означает право «входить», r — читать список файлов.'],
      [['-R', 'рекурсивно'], ['u+x, go-w', 'символьная форма']],
      ['chmod 600 ~/.ssh/authorized_keys', 'chmod u+x script.sh'],
      'chown(1), umask(1)'));

  page('find', 1, 'search for files in a directory hierarchy',
    fmt('find', 1, 'поиск файлов',
      ['find [path...] [expression]'],
      ['Обходит дерево каталогов и фильтрует по имени, типу, размеру, времени.'],
      [['-name PATTERN', 'по имени (шаблон в кавычках)'], ['-type f|d|l', 'тип'],
        ['-size +1M', 'размер'], ['-mmin -10', 'изменён за последние 10 мин'],
        ['-exec cmd {} \;', 'выполнить команду']],
      ['find /etc -name "*.yaml"', 'find /var/log -type f -mmin -30'],
      'grep(1), ls(1)'));

  page('awk', 1, 'pattern scanning and processing language',
    fmt('awk', 1, 'обработка текста по столбцам',
      ['awk [-F fs] \'program\' [file...]'],
      ['Незаменим для вытаскивания полей из вывода сетевых команд.'],
      [['-F fs', 'разделитель полей'], ['$1..$NF', 'поля строки'], ['NR', 'номер строки'],
        ['BEGIN/END', 'блоки до и после обработки']],
      ['ip -br a | awk \'{print $1, $3}\'', 'ss -tulpn | awk \'NR>1 {print $5}\''],
      'sed(1), cut(1)'));

  page('sed', 1, 'stream editor for filtering and transforming text',
    fmt('sed', 1, 'потоковый редактор',
      ['sed [OPTION]... {script} [input-file]...'],
      ['Замена и удаление строк, в том числе правка конфигов на месте (-i).'],
      [['s/old/new/g', 'замена'], ['-i', 'править файл на месте'],
        ['-n \'5p\'', 'напечатать только 5-ю строку'], ['/pattern/d', 'удалить строки']],
      ['sed -n \'1,5p\' /etc/netplan/01-netcfg.yaml',
        'sudo sed -i \'s/#Port 22/Port 2222/\' /etc/ssh/sshd_config'],
      'awk(1), grep(1)'));

  page('traceroute', 8, 'print the route packets trace to network host',
    fmt('traceroute', 8, 'трассировка пути до узла',
      ['traceroute [-n] [-I] [-m max_ttl] host'],
      ['Показывает, где обрывается путь. Звёздочки не всегда значат потерю:',
        'узел может просто не отвечать ICMP, а трафик идти дальше.'],
      [['-n', 'без резолва имён'], ['-I', 'использовать ICMP вместо UDP'],
        ['-m N', 'максимальный TTL'], ['-w sec', 'таймаут пробы']],
      ['traceroute -n 8.8.8.8', 'tracepath 8.8.8.8   # ещё покажет MTU'],
      'ping(8), mtr(8)'));

  page('ethtool', 8, 'query or control network driver and hardware settings',
    fmt('ethtool', 8, 'параметры сетевого адаптера',
      ['ethtool [interface]'],
      ['Показывает, есть ли физический линк (Link detected) и скорость порта.',
        'Первый шаг, когда интерфейс «не поднимается».'],
      [['-i', 'драйвер'], ['-S', 'статистика адаптера']],
      ['ethtool ens33', 'ethtool -S ens33'],
      'ip-link(8)'));

  page('bash', 1, 'GNU Bourne-Again SHell',
    fmt('bash', 1, 'командная оболочка',
      ['bash [options] [file]'],
      ['Пайплайны |, перенаправления > >> < 2>, списки && || ;, подстановка $( ),',
        'переменные и экранирование — минимум, который экономит часы работы.'],
      [['cmd1 | cmd2', 'stdout первой на stdin второй'],
        ['cmd > file 2>&1', 'stdout и stderr в файл'],
        ['cmd1 && cmd2', 'вторая выполнится только при успехе первой'],
        ['$?', 'код возврата последней команды']],
      ['ip a | grep inet | awk \'{print $2}\'', 'systemctl is-active ssh && echo OK'],
      'sh(1)'));

  NET.man = {
    get: function (name) { return pages[name] || null; },
    names: function () { return Object.keys(pages).sort(); },
    page: page
  };
})(window.NET);
