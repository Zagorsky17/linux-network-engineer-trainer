/*
 * tests/system.js — раздел «Система и службы» каталога тестов.
 * Службы systemd, журналы, пакеты и параметры ядра.
 */
(function (NET) {
  'use strict';

  NET.quiz.group({
    id: 'system', title: 'Система и службы',
    desc: 'systemd, журналы, пакеты и параметры ядра: чем живёт сервер между перезагрузками.'
  });

  var meta = function (title, desc) { return { title: title, desc: desc, group: 'system' }; };

  /* ================= systemd ================= */

  NET.quiz.add('t-systemd', [
    {
      cmd: 'systemctl', q: 'Служба работает сейчас, но после перезагрузки не поднимается. Чего не хватает?',
      options: ['systemctl enable — служба не добавлена в автозапуск', 'systemctl start', 'systemctl reload', 'systemctl daemon-reload'],
      answer: 0, explain: 'start запускает здесь и сейчас, enable создаёт ссылку для автозапуска. Обычно нужны обе: systemctl enable --now.'
    },
    {
      cmd: 'systemctl', q: 'Что означает строка «Active: failed (Result: exit-code)» в systemctl status?',
      options: ['Служба запускалась и завершилась с ненулевым кодом', 'Служба остановлена вручную', 'Служба не установлена', 'Служба ждёт сокет'],
      answer: 0, explain: 'failed — попытка запуска была и закончилась ошибкой; причину ищут в journalctl -u имя.'
    },
    {
      cmd: 'systemctl', q: 'Чем systemctl reload отличается от restart?',
      options: ['reload заставляет службу перечитать конфигурацию, не разрывая текущие соединения', 'reload перезапускает службу быстрее', 'reload применяется только к systemd', 'Разницы нет'],
      answer: 0, explain: 'restart гасит процесс и поднимает заново — обрываются соединения. reload доступен, если служба это умеет.'
    },
    {
      cmd: 'systemctl', q: 'Как посмотреть список всех служб и их состояние?',
      options: ['systemctl list-units --type=service', 'systemctl status', 'service --list', 'systemctl show'],
      answer: 0, explain: 'list-units показывает загруженные юниты; --type=service ограничивает вывод службами.'
    },
    {
      cmd: 'systemctl', q: 'Что делает systemctl mask nginx?',
      options: ['Полностью запрещает запуск службы, в том числе вручную и по зависимости', 'Останавливает службу до перезагрузки', 'Скрывает службу из списка', 'Отключает только автозапуск'],
      answer: 0, explain: 'mask подменяет юнит ссылкой на /dev/null. Снимается через unmask — иначе start будет молча отказывать.'
    },
    {
      cmd: 'journalctl', q: 'Как посмотреть журнал только одной службы?',
      options: ['journalctl -u nginx', 'journalctl nginx', 'journalctl -f nginx', 'journalctl --service nginx'],
      answer: 0, explain: '-u фильтрует по юниту. С -f вывод продолжится в реальном времени, с -n 50 покажет последние 50 строк.'
    },
    {
      cmd: 'journalctl', q: 'Какой ключ ограничит журнал текущей загрузкой системы?',
      options: ['journalctl -b', 'journalctl -k', 'journalctl -p', 'journalctl -r'],
      answer: 0, explain: '-b — записи с последней загрузки. Это отсекает всё, что было до перезагрузки, и сокращает поиск.'
    },
    {
      cmd: 'journalctl', q: 'Как оставить в журнале только сообщения уровня «ошибка» и выше?',
      options: ['journalctl -p err', 'journalctl --error', 'journalctl -l err', 'journalctl -u err'],
      answer: 0, explain: '-p задаёт приоритет по syslog: emerg, alert, crit, err, warning, notice, info, debug.'
    },
    {
      cmd: 'systemctl', q: 'После правки файла юнита служба запускается со старыми параметрами. Что забыли?',
      options: ['systemctl daemon-reload — systemd не перечитал файлы юнитов', 'systemctl enable', 'systemctl mask', 'Перезагрузить сервер'],
      answer: 0, explain: 'systemd кеширует юниты. daemon-reload перечитывает их с диска, после чего нужен restart службы.'
    }
  ], meta('systemd и журналы', 'systemctl, journalctl — запуск, автозапуск и поиск причины отказа службы.'));

  /* ================= Пакеты ================= */

  NET.quiz.add('t-pkg', [
    {
      cmd: 'apt', q: 'Что делает apt update?',
      options: ['Обновляет список доступных пакетов из репозиториев', 'Обновляет все установленные пакеты', 'Устанавливает обновления безопасности', 'Обновляет систему до новой версии'],
      answer: 0, explain: 'update только обновляет индексы. Сами пакеты обновляет apt upgrade.'
    },
    {
      cmd: 'apt', q: 'Какой командой установить пакет без вопросов в скрипте?',
      options: ['apt install -y nginx', 'apt install --force nginx', 'apt -q install nginx', 'apt install nginx --now'],
      answer: 0, explain: '-y отвечает «да» на подтверждения. Без него установка в скрипте зависнет на вопросе.'
    },
    {
      cmd: 'apt', q: 'Чем apt remove отличается от apt purge?',
      options: ['purge удаляет ещё и конфигурационные файлы пакета', 'purge удаляет зависимости', 'remove удаляет только конфиги', 'Разницы нет'],
      answer: 0, explain: 'После remove настройки остаются — при повторной установке пакет вернётся со старым конфигом.'
    },
    {
      cmd: 'apt', q: 'Как найти пакет по слову в названии и описании?',
      options: ['apt search слово', 'apt find слово', 'apt list слово', 'apt show слово'],
      answer: 0, explain: 'search ищет по индексу пакетов; show покажет подробности уже известного пакета.'
    },
    {
      cmd: 'dpkg', q: 'Как узнать, какому пакету принадлежит файл /usr/sbin/nginx?',
      options: ['dpkg -S /usr/sbin/nginx', 'dpkg -l nginx', 'dpkg -i nginx', 'apt show nginx'],
      answer: 0, explain: '-S (search) ищет файл в базе установленных пакетов — так выясняют происхождение незнакомого бинарника.'
    },
    {
      cmd: 'dpkg', q: 'Что покажет dpkg -l | grep nginx?',
      options: ['Установленные пакеты, в названии которых есть nginx, и их состояние', 'Файлы пакета nginx', 'Журнал установки nginx', 'Доступные версии nginx в репозитории'],
      answer: 0, explain: 'Первый столбец — состояние: ii значит «установлен и настроен», rc — удалён, но конфиги остались.'
    },
    {
      cmd: 'dpkg', q: 'Как посмотреть список файлов, установленных пакетом?',
      options: ['dpkg -L nginx', 'dpkg -l nginx', 'dpkg -s nginx', 'dpkg -c nginx'],
      answer: 0, explain: '-L печатает пути всех файлов пакета: быстро находится и бинарник, и каталог конфигов.'
    },
    {
      cmd: 'apt', q: 'apt install падает с «Unable to locate package». Что проверить первым?',
      options: ['Выполнен ли apt update и доступны ли репозитории', 'Свободное место на диске', 'Права на /usr/bin', 'Версию ядра'],
      answer: 0, explain: 'Пустые или устаревшие индексы — самая частая причина. Второй кандидат — нет сети или DNS до зеркала.'
    }
  ], meta('Пакеты: apt и dpkg', 'apt update/install/remove/search, dpkg -l/-L/-S — установка и разбор пакетов.'));

  /* ================= Ядро, время, задания ================= */

  NET.quiz.add('t-kernel', [
    {
      cmd: 'sysctl', q: 'Как посмотреть текущее значение параметра ядра net.ipv4.ip_forward?',
      options: ['sysctl net.ipv4.ip_forward', 'sysctl -w net.ipv4.ip_forward', 'systemctl show ip_forward', 'cat /etc/sysctl.conf'],
      answer: 0, explain: 'sysctl читает живое значение из /proc/sys. Файл конфигурации может расходиться с тем, что применено сейчас.'
    },
    {
      cmd: 'sysctl', q: 'Значение задано через sysctl -w и пропало после перезагрузки. Почему?',
      options: ['-w меняет параметр только в памяти; чтобы он пережил перезагрузку, нужен файл в /etc/sysctl.d/', '-w требует прав root', 'Параметр не поддерживается ядром', 'Нужно было выполнить sysctl -a'],
      answer: 0, explain: 'Постоянные значения читаются при загрузке из /etc/sysctl.conf и /etc/sysctl.d/*.conf.'
    },
    {
      cmd: 'sysctl', q: 'Что делает sysctl -p /etc/sysctl.d/99-net.conf?',
      options: ['Применяет параметры из указанного файла немедленно', 'Печатает все параметры ядра', 'Проверяет файл на ошибки, не применяя', 'Удаляет параметры из файла'],
      answer: 0, explain: '-p загружает значения из файла — так проверяют настройку, не перезагружая сервер.'
    },
    {
      cmd: 'sysctl', q: 'Зачем включают net.ipv4.ip_forward = 1?',
      options: ['Чтобы хост пересылал транзитные пакеты между интерфейсами, то есть работал маршрутизатором', 'Чтобы ускорить сетевой стек', 'Чтобы разрешить входящие соединения', 'Чтобы включить IPv6'],
      answer: 0, explain: 'Без этого параметра Linux принимает только адресованные себе пакеты, а транзит молча отбрасывает.'
    },
    {
      cmd: 'hostnamectl', q: 'Как изменить имя хоста так, чтобы оно сохранилось после перезагрузки?',
      options: ['hostnamectl set-hostname имя', 'hostname имя', 'echo имя > /proc/sys/kernel/hostname', 'export HOSTNAME=имя'],
      answer: 0, explain: 'hostname задаёт имя только до перезагрузки; hostnamectl записывает его в /etc/hostname.'
    },
    {
      cmd: 'crontab', q: 'Что означает строка 0 3 * * * /usr/local/bin/backup.sh?',
      options: ['Запуск каждый день в 3:00', 'Запуск каждые 3 часа', 'Запуск 3-го числа каждого месяца', 'Запуск каждую минуту в течение трёх часов'],
      answer: 0, explain: 'Поля: минута, час, день месяца, месяц, день недели. 0 3 — ровно в три часа ночи ежедневно.'
    },
    {
      cmd: 'crontab', q: 'Зачем при разборе инцидента смотреть crontab -l?',
      options: ['Задание по расписанию могло изменить конфигурацию или вернуть удалённый файл', 'Cron хранит журнал входов', 'Cron показывает нагрузку на систему', 'Cron перечисляет установленные пакеты'],
      answer: 0, explain: 'Классика: «починил — через пять минут сломалось снова». Виновником оказывается задание cron.'
    },
    {
      cmd: 'date', q: 'Почему расхождение времени на сервере мешает разбору инцидента?',
      options: ['Записи журналов разных машин перестают сходиться по времени', 'Команды начинают выполняться медленнее', 'Сеть перестаёт работать', 'Журналы перестают писаться'],
      answer: 0, explain: 'Сопоставление событий по времени — основа разбора. Ещё время критично для TLS-сертификатов и аутентификации.'
    }
  ], meta('Ядро, время и расписание', 'sysctl, hostnamectl, crontab, date — параметры системы и регулярные задания.'));

})(window.NET);
