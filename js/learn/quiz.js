/*
 * quiz.js — тесты по командам, которые используются в лабораторных.
 *
 * Один тест на урок (вводный и по одному на лабораторную). Вопрос проверяет
 * не память на ключи, а понимание: что показывает команда, когда её
 * применять и как читать результат. Каждый вариант ответа сопровождается
 * объяснением, которое показывается после выбора.
 *
 * Вопрос: { q, cmd, options[], answer (индекс верного), explain }.
 * cmd — команда, о которой вопрос: селфтест проверяет, что она реализована
 * в тренажёре, а панель показывает её рядом с вопросом.
 * Порядок вариантов перемешивается при каждом прохождении (ui/panel_quiz.js),
 * поэтому позиция верного ответа в данных роли не играет.
 */
(function (NET) {
  'use strict';

  var PASS_PERCENT = 75;
  var quizzes = {};

  function quiz(id, questions) { quizzes[id] = questions; }

  /* ================= Вводный урок ================= */

  quiz('linux-basics', [
    {
      cmd: 'echo $?', q: 'Что выведет echo $? сразу после успешно выполненной команды?',
      options: ['0', '1', 'true', 'Имя последней команды'],
      answer: 0, explain: '$? — код завершения последней команды. 0 означает успех, любое другое число — ошибку.'
    },
    {
      cmd: 'grep', q: 'Как найти в файле все строки со словом Port вместе с номерами строк?',
      options: ['grep -n Port файл', 'grep -v Port файл', 'find Port файл', 'cat -n файл Port'],
      answer: 0, explain: '-n добавляет номер строки. -v, наоборот, выводит строки без совпадения.'
    },
    {
      cmd: 'tail', q: 'Какая команда показывает последние 20 строк журнала и продолжает выводить новые?',
      options: ['tail -n 20 -f /var/log/syslog', 'head -n 20 /var/log/syslog', 'cat /var/log/syslog | less', 'less -20 /var/log/syslog'],
      answer: 0, explain: 'tail -n N выводит конец файла, -f продолжает следить за новыми строками.'
    },
    {
      cmd: 'ls', q: 'Строка ls -l начинается с -rw-------. Кто может читать этот файл?',
      options: ['Только владелец (и root)', 'Все пользователи', 'Владелец и его группа', 'Никто, включая владельца'],
      answer: 0, explain: 'Первая тройка rw- — права владельца, у группы и остальных стоит ---. root обходит эти права.'
    },
    {
      cmd: 'sudo', q: 'cat /etc/netplan/01-netcfg.yaml выдаёт «Permission denied». Как правильно прочитать файл?',
      options: ['sudo cat /etc/netplan/01-netcfg.yaml', 'chmod 777 /etc/netplan/01-netcfg.yaml', 'cat -f /etc/netplan/01-netcfg.yaml', 'su и удалить файл'],
      answer: 0, explain: 'Файл защищён намеренно (права 600). sudo даёт права root на одну команду; ослаблять права конфигурации не нужно.'
    },
    {
      cmd: 'systemctl', q: 'Как посмотреть, запущена ли служба ssh и какие у неё последние записи журнала?',
      options: ['systemctl status ssh', 'systemctl enable ssh', 'ps ssh', 'service ssh reload'],
      answer: 0, explain: 'status показывает состояние (active/inactive/failed), PID и последние строки журнала.'
    },
    {
      cmd: 'journalctl', q: 'Какая команда покажет последние 50 записей журнала службы nginx?',
      options: ['journalctl -u nginx -n 50', 'journalctl -f 50 nginx', 'tail -50 nginx', 'systemctl log nginx'],
      answer: 0, explain: '-u фильтрует по юниту, -n ограничивает число записей.'
    },
    {
      cmd: 'ps', q: 'Как найти процесс nginx среди всех процессов системы?',
      options: ['ps aux | grep nginx', 'ls /proc | nginx', 'top nginx', 'kill -l nginx'],
      answer: 0, explain: 'ps aux выводит все процессы, конвейер | передаёт вывод в grep для фильтрации.'
    }
  ]);

  /* ================= Lab 01 ================= */

  quiz('lab01', [
    {
      cmd: 'ip', q: 'Что показывает ip -br a?',
      options: ['Интерфейсы, их состояние и адреса — одной строкой на интерфейс', 'Таблицу маршрутов', 'ARP-таблицу', 'Открытые порты'],
      answer: 0, explain: '-br (brief) сжимает вывод ip addr до одной строки на интерфейс.'
    },
    {
      cmd: 'ip', q: 'Какая команда покажет, через какой шлюз и интерфейс ядро отправит пакет на 8.8.8.8?',
      options: ['ip route get 8.8.8.8', 'ping 8.8.8.8', 'ip neigh', 'dig 8.8.8.8'],
      answer: 0, explain: 'ip route get возвращает решение ядра: via, dev и адрес источника.'
    },
    {
      cmd: 'ping', q: 'ping 8.8.8.8 мгновенно выдаёт «Network is unreachable». Наиболее вероятная причина?',
      options: ['В локальной таблице нет подходящего маршрута', 'Удалённый сервер выключен', 'Firewall провайдера', 'Не работает DNS'],
      answer: 0, explain: 'Эту ошибку формирует ваше ядро до отправки пакета: для адреса нет маршрута.'
    },
    {
      cmd: 'ip', q: 'Что означает строка «default via 192.168.10.1 dev ens33»?',
      options: ['Все адреса вне известных подсетей отправлять шлюзу 192.168.10.1 через ens33', 'Адрес интерфейса ens33', 'Адрес DNS-сервера', 'Подсеть, подключённую напрямую'],
      answer: 0, explain: 'default — маршрут «для всего остального», via — следующий узел.'
    },
    {
      cmd: 'ping', q: 'Зачем пинговать шлюз перед внешним адресом?',
      options: ['Чтобы отделить проблемы локального сегмента от проблем маршрутизации дальше', 'Шлюз отвечает быстрее', 'Иначе ping не работает', 'Чтобы обновить ARP-кэш провайдера'],
      answer: 0, explain: 'Это деление пути пополам: успех исключает кабель, адрес, маску и L2 до шлюза.'
    },
    {
      cmd: 'ip', q: 'Чем ip route add отличается от записи маршрута в /etc/netplan?',
      options: ['ip route add действует до перезагрузки, netplan — постоянная конфигурация', 'Ничем', 'netplan работает только с DHCP', 'ip route add сохраняет маршрут в файл'],
      answer: 0, explain: 'ip меняет состояние ядра, netplan — файлы, из которых это состояние восстанавливается.'
    },
    {
      cmd: 'ping', q: 'Какой ключ ping задаёт число запросов?',
      options: ['-c', '-s', '-M', '-t'],
      answer: 0, explain: '-c count. -s задаёт размер данных, -M do запрещает фрагментацию.'
    },
    {
      cmd: 'traceroute', q: 'traceroute -n 8.8.8.8 показывает ответ от 192.168.10.1, дальше только «* * *». Где искать?',
      options: ['На шлюзе и за ним: его аплинк, маршруты, NAT', 'На srv1: нет маршрута по умолчанию', 'В DNS', 'В ARP-таблице srv1'],
      answer: 0, explain: 'Шлюз ответил — до него путь исправен. Обрыв на нём или сразу за ним.'
    }
  ]);

  /* ================= Lab 02 ================= */

  quiz('lab02', [
    {
      cmd: 'netplan', q: 'Где в Ubuntu хранится постоянная конфигурация сети?',
      options: ['/etc/netplan/*.yaml', '/etc/network/ip.conf', '/proc/net/config', '/var/lib/netplan.db'],
      answer: 0, explain: 'netplan читает YAML-файлы из /etc/netplan и передаёт настройки бэкенду (networkd или NetworkManager).'
    },
    {
      cmd: 'netplan', q: 'Какая команда проверит синтаксис конфигурации netplan, не применяя её?',
      options: ['sudo netplan generate', 'sudo netplan apply', 'sudo netplan status --fix', 'cat /etc/netplan/*.yaml'],
      answer: 0, explain: 'generate строит конфигурацию бэкенда и сообщает об ошибках, ничего не меняя на интерфейсах.'
    },
    {
      cmd: 'netplan', q: 'Чем netplan try отличается от netplan apply?',
      options: ['try откатывает изменения, если их не подтвердить', 'try ничего не применяет', 'try применяет только к одному интерфейсу', 'Ничем'],
      answer: 0, explain: 'try — страховка при удалённой работе: без подтверждения конфигурация вернётся к прежней.'
    },
    {
      cmd: 'netplan', q: 'netplan выдаёт ошибку «address is missing /prefixlength». Что исправить?',
      options: ['Указать адрес с префиксом, например 192.168.10.25/24', 'Добавить шлюз', 'Заменить пробелы табуляцией', 'Перезагрузить сервер'],
      answer: 0, explain: 'В addresses адрес всегда пишется вместе с длиной префикса.'
    },
    {
      cmd: 'netplan', q: 'Что недопустимо в YAML-файле netplan?',
      options: ['Табуляция в отступах', 'Комментарии через #', 'Списки в квадратных скобках', 'Несколько адресов на интерфейсе'],
      answer: 0, explain: 'YAML принимает только пробелы в отступах; табуляция даёт ошибку разбора.'
    },
    {
      cmd: 'resolvectl', q: 'Как проверить, какие DNS-серверы получил systemd-resolved из netplan?',
      options: ['resolvectl status', 'ip route', 'dig -x', 'netplan get dns'],
      answer: 0, explain: 'resolvectl status показывает серверы и домены поиска по каждому интерфейсу.'
    },
    {
      cmd: 'netplan', q: 'Вы добавили адрес командой ip addr add, а затем выполнили netplan apply. Что стало с ручным адресом?',
      options: ['Исчез: apply переконфигурирует интерфейс по файлу', 'Остался вместе с новым', 'Записался в файл', 'apply завершился ошибкой'],
      answer: 0, explain: 'netplan apply приводит интерфейс к состоянию из файла, ручные изменения затираются.'
    },
    {
      cmd: 'nmcli', q: 'Сетью управляет NetworkManager. Какой командой посмотреть профили подключений?',
      options: ['nmcli con show', 'nmcli ip show', 'netplan con', 'systemctl con'],
      answer: 0, explain: 'nmcli con show — профили, nmcli dev status — устройства.'
    }
  ]);

  /* ================= Lab 03 ================= */

  quiz('lab03', [
    {
      cmd: 'ip', q: 'В таблице есть default via A и 10.20.0.0/16 via B. Куда пойдёт пакет на 10.20.5.10?',
      options: ['На B — более длинный префикс', 'На A — default приоритетнее', 'На оба по очереди', 'Пакет отбросится'],
      answer: 0, explain: 'Ядро выбирает самое точное совпадение (longest prefix match): /16 точнее /0.'
    },
    {
      cmd: 'ip', q: 'Какая команда проверит выбор маршрута для конкретного адреса?',
      options: ['ip route get 10.20.5.10', 'ip route show 10.20.5.10 all', 'route --test', 'ip neigh get'],
      answer: 0, explain: 'ip route get называет маршрут, next-hop, интерфейс и адрес источника.'
    },
    {
      cmd: 'ip', q: 'В ip neigh next-hop в состоянии INCOMPLETE. Что это значит?',
      options: ['ARP-запрос ушёл, ответа нет — соседа нет в сегменте', 'Сосед работает, но медленно', 'Таблица ещё заполняется, всё нормально', 'Маршрута нет'],
      answer: 0, explain: 'INCOMPLETE/FAILED — MAC не получен. Next-hop по этому адресу не существует или недоступен.'
    },
    {
      cmd: 'ip', q: 'Как удалить маршрут 10.20.0.0/16 через 192.168.10.254?',
      options: ['sudo ip route del 10.20.0.0/16 via 192.168.10.254', 'sudo ip route flush all', 'sudo ip neigh del 192.168.10.254', 'sudo route -n del'],
      answer: 0, explain: 'del с тем же описанием маршрута удаляет конкретную запись. flush удалил бы все маршруты.'
    },
    {
      cmd: 'traceroute', q: 'Зачем traceroute ключ -n?',
      options: ['Не разрешать адреса в имена — быстрее и без DNS-запросов', 'Ограничить число хопов', 'Использовать TCP', 'Показать номера портов'],
      answer: 0, explain: 'Без -n traceroute делает обратные DNS-запросы для каждого узла, это медленно и путает при сломанном DNS.'
    },
    {
      cmd: 'traceroute', q: 'На хосте маршруты верные, traceroute обрывается после шлюза. Что делать?',
      options: ['Зайти на шлюз и проверить его маршруты до сети назначения', 'Добавить второй default на хосте', 'Перезапустить сетевую службу хоста', 'Очистить ARP на хосте'],
      answer: 0, explain: 'Хост своё сделал — отдал пакет шлюзу. Дальше путь определяют маршруты шлюза.'
    },
    {
      cmd: 'ping', q: 'Интернет работает, а сеть филиала — «Destination Host Unreachable». О чём это говорит?',
      options: ['Для филиала выбирается отдельный маршрут, и его next-hop недоступен', 'Филиал выключен', 'Нет маршрута по умолчанию', 'Сломан DNS'],
      answer: 0, explain: 'Если бы трафик шёл через default, как в интернет, ошибки ARP не было бы. Значит, работает другой маршрут.'
    },
    {
      cmd: 'ip', q: 'Какой командой временно заменить шлюз для сети, не удаляя маршрут отдельно?',
      options: ['sudo ip route replace 10.20.0.0/16 via 192.168.10.1', 'sudo ip route add 10.20.0.0/16 via 192.168.10.1 force', 'sudo ip route change default', 'sudo ip link set via'],
      answer: 0, explain: 'replace создаёт маршрут или заменяет существующий с тем же префиксом.'
    }
  ]);

  /* ================= Lab 04 ================= */

  quiz('lab04', [
    {
      cmd: 'cat', q: 'Где посмотреть, к какому DNS-серверу обращается системный резолвер?',
      options: ['/etc/resolv.conf', '/etc/hosts.allow', '/etc/dns.d/server', '/proc/net/dns'],
      answer: 0, explain: 'Строки nameserver в /etc/resolv.conf. Для systemd-resolved там 127.0.0.53, реальные серверы — в resolvectl status.'
    },
    {
      cmd: 'dig', q: 'Как спросить конкретный сервер 192.168.10.5, минуя настройки клиента?',
      options: ['dig @192.168.10.5 app1.corp.local', 'dig app1.corp.local -s 192.168.10.5', 'nslookup -x 192.168.10.5', 'host --server app1'],
      answer: 0, explain: 'Синтаксис @сервер задаёт, к кому dig обращается.'
    },
    {
      cmd: 'dig', q: 'dig возвращает status: NXDOMAIN. Что это значит?',
      options: ['Сервер работает и ответил, что такого имени нет', 'Сервер недоступен', 'Сервер сломан', 'Нет сети'],
      answer: 0, explain: 'NXDOMAIN — уверенный ответ сервера. Проверьте имя, домен поиска и содержимое зоны.'
    },
    {
      cmd: 'dig', q: 'dig пишет «communications error … no servers could be reached». Что проверить первым?',
      options: ['Доступен ли DNS-сервер по IP и слушает ли он 53/udp', 'Есть ли запись в зоне', 'Правильно ли написано имя', 'TTL записи'],
      answer: 0, explain: 'Ответа нет вообще — сервер недоступен или служба не работает.'
    },
    {
      cmd: 'dig', q: 'Какой ключ dig выводит только адрес, без служебных секций?',
      options: ['+short', '-q', '+brief', '-s'],
      answer: 0, explain: '+short удобен для быстрых проверок и скриптов.'
    },
    {
      cmd: 'resolvectl', q: 'В resolv.conf указан 127.0.0.53. Что это?',
      options: ['Локальная заглушка systemd-resolved', 'Ошибка конфигурации', 'Адрес шлюза', 'Публичный DNS'],
      answer: 0, explain: 'systemd-resolved слушает 127.0.0.53 и пересылает запросы настоящим серверам.'
    },
    {
      cmd: 'ping', q: 'ping 8.8.8.8 работает, ping www.example.com — «Name or service not known». Какой уровень исправен точно?',
      options: ['IP-связность и маршрутизация', 'DNS', 'Всё, кроме интерфейса', 'Ничего нельзя сказать'],
      answer: 0, explain: 'Пакеты по IP доходят — сломано только разрешение имён.'
    },
    {
      cmd: 'netplan', q: 'Почему правка /etc/resolv.conf вручную — плохое исправление?',
      options: ['Файл генерируется заново из netplan/DHCP и перезапишется', 'Файл только для чтения', 'Изменения требуют перезагрузки', 'resolv.conf не используется'],
      answer: 0, explain: 'Править нужно источник — nameservers в netplan или профиле NetworkManager.'
    }
  ]);

  /* ================= Lab 05 ================= */

  quiz('lab05', [
    {
      cmd: 'ss', q: 'Какая команда покажет слушающие TCP-порты вместе с процессами?',
      options: ['sudo ss -tlnp', 'ss -a', 'ip -s link', 'netstat -r'],
      answer: 0, explain: 't — TCP, l — слушающие, n — без имён, p — процесс (нужен sudo).'
    },
    {
      cmd: 'ss', q: 'ss показывает LISTEN 127.0.0.1:443. Что увидит внешний клиент?',
      options: ['Connection refused — сокета на внешнем адресе нет', 'Успешное подключение', 'Таймаут', 'Ошибку DNS'],
      answer: 0, explain: 'Сервис доступен только с самого хоста; на внешний адрес ядро отвечает RST.'
    },
    {
      cmd: 'nc', q: 'nc -zv сервер 443 с клиента ждёт и завершается «Connection timed out». Вероятная причина?',
      options: ['Пакеты молча отбрасываются (DROP) или не доходят', 'Сервис не запущен', 'Неверный сертификат', 'Порт занят другим процессом'],
      answer: 0, explain: 'Не запущенный сервис дал бы мгновенный refused. Таймаут — признак DROP или обрыва пути.'
    },
    {
      cmd: 'ufw', q: 'ufw status verbose показывает «Default: deny (incoming)». Что это значит?',
      options: ['Входящее запрещено всё, кроме явно разрешённого', 'Firewall выключен', 'Запрещён только исходящий трафик', 'Разрешено всё, кроме указанного'],
      answer: 0, explain: 'Политика по умолчанию применяется ко всему, что не попало под правила.'
    },
    {
      cmd: 'ufw', q: 'Как открыть HTTPS только для сети 192.168.10.0/24?',
      options: ['sudo ufw allow from 192.168.10.0/24 to any port 443 proto tcp', 'sudo ufw allow 443 192.168.10.0', 'sudo ufw enable 443/tcp', 'sudo ufw default allow'],
      answer: 0, explain: 'from ограничивает источник. default allow открыл бы вообще всё.'
    },
    {
      cmd: 'ufw', q: 'Что сделать до ufw enable на удалённом сервере?',
      options: ['Разрешить SSH: sudo ufw allow OpenSSH', 'Перезагрузить сервер', 'Остановить sshd', 'Очистить iptables'],
      answer: 0, explain: 'Иначе политика deny закроет и вашу сессию.'
    },
    {
      cmd: 'iptables', q: 'Как увидеть правила INPUT с номерами для последующего удаления?',
      options: ['sudo iptables -L INPUT -n --line-numbers', 'sudo iptables -F INPUT', 'sudo iptables -P INPUT', 'sudo iptables -X'],
      answer: 0, explain: '-L выводит правила, --line-numbers — их номера. -F удалил бы все правила цепочки.'
    },
    {
      cmd: 'curl', q: 'Зачем проверять сервис командой curl на 127.0.0.1?',
      options: ['Чтобы проверить сервис без участия сети и внешнего фильтра', 'Чтобы проверить DNS', 'Чтобы обойти TLS', 'Это единственный способ проверить порт'],
      answer: 0, explain: 'Локальный ответ отделяет «сломан сервис» от «трафик не доходит».'
    }
  ]);

  /* ================= Lab 06 ================= */

  quiz('lab06', [
    {
      cmd: 'ping', q: 'Что делает ключ -M do в ping?',
      options: ['Запрещает фрагментацию (устанавливает DF)', 'Включает режим отладки', 'Задаёт MTU интерфейса', 'Шлёт пакеты максимального размера'],
      answer: 0, explain: 'С DF маршрутизатор не может разрезать пакет и должен сообщить о превышении MTU.'
    },
    {
      cmd: 'ping', q: 'Какой размер задать в ping -s, чтобы IP-пакет был ровно 1500 байт?',
      options: ['1472', '1500', '1480', '1528'],
      answer: 0, explain: '1472 байта данных + 8 ICMP + 20 IP = 1500.'
    },
    {
      cmd: 'ping', q: 'ping -s 1472 -M do пропадает без ошибок, ping -s 1372 -M do проходит. Вывод?',
      options: ['MTU пути между 1400 и 1500, ICMP «frag needed» не доходит', 'Потери на канале', 'Сервер перегружен', 'Не работает DNS'],
      answer: 0, explain: 'Молчаливая потеря именно крупных пакетов — MTU blackhole.'
    },
    {
      cmd: 'tracepath', q: 'tracepath показывает pmtu 1500, а 1500-байтные пакеты не проходят. Почему?',
      options: ['ICMP заглушён — tracepath не получил сообщения о меньшем MTU', 'tracepath врёт всегда', 'MTU меняется каждую секунду', 'Нужен sudo'],
      answer: 0, explain: 'tracepath полагается на тот же ICMP, что и PMTUD. Если его режут, прямое измерение ping надёжнее.'
    },
    {
      cmd: 'ip', q: 'Как временно установить MTU 1400 на ens33?',
      options: ['sudo ip link set ens33 mtu 1400', 'sudo ip addr mtu 1400 ens33', 'sudo ethtool -m 1400 ens33', 'sudo netplan mtu 1400'],
      answer: 0, explain: 'ip link set меняет параметры интерфейса до перезагрузки. Постоянно — ключ mtu в netplan.'
    },
    {
      cmd: 'ip', q: 'Где увидеть текущий MTU интерфейса?',
      options: ['ip link show ens33', 'ip route', 'ss -i', 'cat /etc/hosts'],
      answer: 0, explain: 'В первой строке вывода: … mtu 1500 qdisc …'
    },
    {
      cmd: 'curl', q: 'Почему curl к сайту устанавливает соединение, но зависает на передаче данных?',
      options: ['Пакеты рукопожатия маленькие, а сегменты с данными полноразмерные', 'Сайт медленный', 'Неверный DNS', 'Закрыт порт 80'],
      answer: 0, explain: 'Классический признак проблемы MTU: мелкое проходит, крупное нет.'
    },
    {
      cmd: 'ping', q: 'ping -s 2000 -M do выдаёт «message too long». Что это значит?',
      options: ['Пакет больше MTU вашего же интерфейса, он даже не отправлен', 'Сервер отверг пакет', 'Сработал firewall', 'Сеть перегружена'],
      answer: 0, explain: 'Ошибку сформировало локальное ядро: с DF пакет не помещается в MTU интерфейса.'
    }
  ]);

  /* ================= Lab 07 ================= */

  quiz('lab07', [
    {
      cmd: 'dhclient', q: 'Какой порядок сообщений DHCP правильный?',
      options: ['DISCOVER → OFFER → REQUEST → ACK', 'REQUEST → OFFER → ACK → DISCOVER', 'OFFER → DISCOVER → ACK → REQUEST', 'DISCOVER → ACK → OFFER → REQUEST'],
      answer: 0, explain: 'Клиент ищет, сервер предлагает, клиент запрашивает, сервер подтверждает.'
    },
    {
      cmd: 'dhclient', q: 'Как вручную запросить адрес с подробным выводом обмена?',
      options: ['sudo dhclient -v ens33', 'sudo ip dhcp ens33', 'sudo netplan dhcp', 'dig dhcp'],
      answer: 0, explain: '-v показывает каждое сообщение: DISCOVER, OFFER, REQUEST, ACK.'
    },
    {
      cmd: 'dhclient', q: 'dhclient пишет «No DHCPOFFERS received». Что это значит?',
      options: ['DISCOVER ушёл, но ни один сервер не ответил', 'Адрес получен', 'Пул исчерпан', 'Нет маршрута по умолчанию'],
      answer: 0, explain: 'Ответа нет: сервер не работает, клиент не в том сегменте или ответы фильтруются.'
    },
    {
      cmd: 'tcpdump', q: 'Какой фильтр tcpdump покажет DHCP-трафик?',
      options: ['port 67 or port 68', 'port 53', 'arp', 'tcp port 67'],
      answer: 0, explain: 'DHCP работает поверх UDP: сервер слушает 67, клиент — 68.'
    },
    {
      cmd: 'ethtool', q: 'ethtool ens33 выводит «Link detected: no». Где проблема?',
      options: ['На физическом уровне: кабель, порт коммутатора', 'В DHCP-сервере', 'В netplan', 'В firewall'],
      answer: 0, explain: 'Без линка программные настройки бессильны, DHCP-клиент не отправит ни пакета.'
    },
    {
      cmd: 'systemctl', q: 'Как запустить DHCP-сервер и включить его автозапуск одной командой?',
      options: ['sudo systemctl enable --now isc-dhcp-server', 'sudo systemctl start --boot isc-dhcp-server', 'sudo systemctl restart isc-dhcp-server', 'sudo service isc-dhcp-server enable'],
      answer: 0, explain: 'enable --now = enable (автозапуск) + start (сейчас).'
    },
    {
      cmd: 'ss', q: 'Как проверить, слушает ли DHCP-сервер свой порт?',
      options: ['sudo ss -lunp | grep :67', 'sudo ss -tlnp | grep :67', 'ip route | grep 67', 'ping -p 67'],
      answer: 0, explain: 'DHCP — UDP, поэтому -u. У TCP-варианта вывод будет пуст даже при работающем сервере.'
    },
    {
      cmd: 'ip', q: 'Клиент получил адрес по DHCP. Как это видно в ip route?',
      options: ['default via … proto dhcp', 'default via … proto static', 'proto kernel у default', 'Никак'],
      answer: 0, explain: 'Маршрут, полученный от DHCP, помечается proto dhcp.'
    }
  ]);

  /* ================= Lab 08 ================= */

  quiz('lab08', [
    {
      cmd: 'ssh', q: 'ssh сразу выдаёт «Connection refused». Что исключено?',
      options: ['Проблемы маршрута и фильтрации DROP — пакет дошёл', 'Проблемы sshd', 'Любые проблемы на сервере', 'Ничего'],
      answer: 0, explain: 'Refused — активный ответ хоста: он доступен, но на порту никто не слушает (или REJECT).'
    },
    {
      cmd: 'ss', q: 'Как проверить, на каком порту реально слушает sshd?',
      options: ['sudo ss -tlnp | grep ssh', 'cat /etc/services | grep ssh', 'systemctl enable ssh', 'ssh -V'],
      answer: 0, explain: 'ss показывает фактическое состояние, /etc/services — только стандартные номера портов.'
    },
    {
      cmd: 'sshd', q: 'Зачем выполнять sudo sshd -t перед перезапуском?',
      options: ['Проверить синтаксис конфигурации, не трогая работающий демон', 'Перезапустить sshd в тестовом режиме', 'Сгенерировать ключи', 'Проверить сеть'],
      answer: 0, explain: 'С ошибкой в конфигурации демон не поднимется, и удалённый доступ пропадёт.'
    },
    {
      cmd: 'grep', q: 'Как быстро найти настройку порта в конфигурации sshd?',
      options: ['grep -n "^Port" /etc/ssh/sshd_config', 'find / -name Port', 'cat /etc/ssh/ssh_config', 'ss -p Port'],
      answer: 0, explain: '^ привязывает поиск к началу строки — закомментированные #Port не попадут.'
    },
    {
      cmd: 'journalctl', q: 'systemctl status ssh показывает failed. Где искать причину?',
      options: ['journalctl -u ssh -n 20', 'ip -br a', 'dmesg | grep eth', 'cat /etc/hosts'],
      answer: 0, explain: 'Журнал юнита содержит сообщение sshd с номером строки конфигурации.'
    },
    {
      cmd: 'systemctl', q: 'Как применить изменённую конфигурацию sshd?',
      options: ['sudo systemctl restart ssh', 'sudo systemctl enable ssh', 'sudo sshd -t', 'sudo netplan apply'],
      answer: 0, explain: 'restart перечитывает конфигурацию. enable лишь включает автозапуск.'
    },
    {
      cmd: 'ssh', q: 'ssh отвечает «Permission denied (publickey)». Где проблема?',
      options: ['В аутентификации: ключ, authorized_keys, права на ~/.ssh', 'В firewall', 'sshd не запущен', 'В маршрутизации'],
      answer: 0, explain: 'Соединение установлено и дошло до проверки ключа — сеть и демон исправны.'
    },
    {
      cmd: 'ufw', q: 'SSH-подключение зависает до таймаута, sshd слушает 22. Что проверить?',
      options: ['Правила firewall на сервере: sudo ufw status numbered', 'Синтаксис sshd_config', 'Ключи пользователя', 'Журнал sshd'],
      answer: 0, explain: 'Таймаут — пакет отброшен. Демон тут ни при чём, ищите DROP.'
    }
  ]);

  /* ================= Lab 09 ================= */

  quiz('lab09', [
    {
      cmd: 'tcpdump', q: 'Что делает ключ -n в tcpdump?',
      options: ['Не разрешает адреса и порты в имена', 'Ограничивает число пакетов', 'Показывает MAC-адреса', 'Пишет в файл'],
      answer: 0, explain: 'Без -n tcpdump делает DNS-запросы, которые засоряют дамп и замедляют вывод.'
    },
    {
      cmd: 'tcpdump', q: 'В дампе на сервере Flags [S] приходят, [S.] не уходят, сокет слушает. Где теряется пакет?',
      options: ['В netfilter на самом сервере', 'На маршрутизаторе по пути', 'У клиента', 'В приложении'],
      answer: 0, explain: 'tcpdump видит пакет до фильтра. Пакет дошёл, но до сокета его не пропустило правило.'
    },
    {
      cmd: 'tcpdump', q: 'Как в дампе выглядит ответ закрытого порта?',
      options: ['Flags [R.] в ответ на [S]', 'Flags [S.]', 'Отсутствие ответа', 'ICMP echo reply'],
      answer: 0, explain: 'RST — активный отказ. Клиент получает Connection refused.'
    },
    {
      cmd: 'tcpdump', q: 'Какой ключ tcpdump показывает MAC-адреса в каждой строке?',
      options: ['-e', '-v', '-X', '-A'],
      answer: 0, explain: '-e печатает заголовок канального уровня — нужно для ARP-диагностики.'
    },
    {
      cmd: 'arping', q: 'arping на адрес получает ответы с двух разных MAC. Что это?',
      options: ['Конфликт IP: адрес занят двумя хостами', 'Нормальная балансировка', 'Ошибка arping', 'Два интерфейса на одном хосте'],
      answer: 0, explain: 'Соседи будут отправлять трафик то одному, то другому хосту — связь «через раз».'
    },
    {
      cmd: 'iptables', q: 'Как удалить первое правило цепочки INPUT?',
      options: ['sudo iptables -D INPUT 1', 'sudo iptables -F INPUT 1', 'sudo iptables -X INPUT', 'sudo iptables -P INPUT 1'],
      answer: 0, explain: '-D по номеру удаляет одно правило. -F очистил бы всю цепочку.'
    },
    {
      cmd: 'tcpdump', q: 'Дамп на сервере пуст, хотя клиент пытается подключиться. Вывод?',
      options: ['Пакеты не доходят до интерфейса сервера — ищите по пути', 'Сервер отбрасывает пакеты', 'Сервис не запущен', 'tcpdump не работает'],
      answer: 0, explain: 'Отсутствие пакетов — тоже результат: трафик теряется до сервера.'
    },
    {
      cmd: 'tcpdump', q: 'Какой фильтр покажет только пакеты с флагом SYN?',
      options: ['"tcp[tcpflags] & tcp-syn != 0"', 'syn only', 'tcp and flags S', 'port syn'],
      answer: 0, explain: 'Выражение проверяет бит SYN в поле флагов TCP-заголовка.'
    }
  ]);

  /* ================= Lab 10 ================= */

  quiz('lab10', [
    {
      cmd: 'ip', q: 'С чего начинать диагностику инцидента «упало всё»?',
      options: ['С нижних уровней: интерфейс, адрес, маршрут', 'С перезагрузки сервера', 'С логов приложения', 'С переустановки пакетов'],
      answer: 0, explain: 'Верхние уровни опираются на нижние. Проверка снизу исключает целые классы причин.'
    },
    {
      cmd: 'systemctl', q: 'Почему systemctl --failed может не показать остановленный nginx?',
      options: ['Он остановлен штатно, а не упал с ошибкой', 'nginx не является службой', 'Нужен sudo', '--failed показывает только сетевые службы'],
      answer: 0, explain: '--failed выводит юниты в состоянии failed. Inactive (dead) туда не попадает.'
    },
    {
      cmd: 'systemctl', q: 'Как убедиться, что nginx запустится после перезагрузки?',
      options: ['systemctl is-enabled nginx → enabled', 'systemctl is-active nginx → active', 'ss -tlnp | grep nginx', 'ps aux | grep nginx'],
      answer: 0, explain: 'is-active говорит о текущем состоянии, is-enabled — об автозапуске.'
    },
    {
      cmd: 'nc', q: 'После открытия 443 в ufw клиент получает refused. Что это значит?',
      options: ['Фильтр пропускает, но сервис не слушает порт', 'Правило не применилось', 'Нужен перезапуск ufw', 'Проблема в DNS'],
      answer: 0, explain: 'Тип отказа сменился с timeout на refused — фильтр больше не мешает, но сокета нет.'
    },
    {
      cmd: 'ss', q: 'Какая команда покажет все слушающие TCP- и UDP-порты с процессами?',
      options: ['sudo ss -tulpn', 'ip -br a', 'systemctl list-units', 'ufw status'],
      answer: 0, explain: 't — TCP, u — UDP, l — слушающие, p — процессы, n — номера.'
    },
    {
      cmd: 'ufw', q: 'Как вернуть SSH, не открывая остальные порты?',
      options: ['sudo ufw allow 22/tcp', 'sudo ufw disable', 'sudo ufw default allow incoming', 'sudo ufw reset'],
      answer: 0, explain: 'Точечное правило. disable и default allow открыли бы всё.'
    },
    {
      cmd: 'ping', q: 'Что делает конструкция ping -c2 192.168.10.1 && ping -c2 8.8.8.8?',
      options: ['Второй ping выполнится, только если первый успешен', 'Оба ping выполнятся параллельно', 'Второй выполнится, только если первый неуспешен', 'Выполнится только второй'],
      answer: 0, explain: '&& продолжает цепочку при коде завершения 0: сразу видно, на каком отрезке обрыв.'
    },
    {
      cmd: 'dig', q: 'DNS отвечает, а ping 8.8.8.8 — «Network is unreachable». Как это возможно?',
      options: ['DNS-сервер в локальной подсети, маршрут по умолчанию ему не нужен', 'Это невозможно', 'DNS кеширует ответы на клиенте', 'dig использует TCP'],
      answer: 0, explain: 'Работающий внутренний DNS не доказывает, что есть выход наружу.'
    }
  ]);

  /* ---------- API ---------- */

  function get(id) {
    var qs = quizzes[id];
    if (!qs) return null;
    var lesson = NET.lessons && NET.lessons.get(id);
    return { id: id, title: lesson ? lesson.title : id, questions: qs, passPercent: PASS_PERCENT };
  }

  /* answers[i] — индекс выбранного варианта в ИСХОДНОМ порядке (или null). */
  function grade(id, answers) {
    var qs = quizzes[id];
    if (!qs) return null;
    var correct = 0;
    var wrong = [];
    qs.forEach(function (q, i) {
      if (answers && answers[i] === q.answer) correct++;
      else wrong.push(i);
    });
    var percent = qs.length ? Math.round(correct * 100 / qs.length) : 0;
    return {
      id: id, correct: correct, total: qs.length, percent: percent,
      passed: percent >= PASS_PERCENT, wrong: wrong
    };
  }

  NET.quiz = {
    get: get,
    grade: grade,
    ids: function () { return Object.keys(quizzes); },
    add: quiz,
    has: function (id) { return !!quizzes[id]; },
    PASS_PERCENT: PASS_PERCENT
  };
})(window.NET);
