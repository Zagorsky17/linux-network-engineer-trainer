# Linux Network Engineer Trainer

Автономный офлайн-тренажёр для сетевого инженера: виртуальная Ubuntu 24.04,
настоящая модель сети и 10 лабораторных работ по диагностике.
HTML + CSS + чистый JavaScript, без сборки, сервера и интернета.

## Запуск

Двойной клик по `index.html` (или «Открыть с помощью → браузер»).
Ничего устанавливать не нужно. Рекомендуется Chrome, Edge, Firefox или Safari
последних версий, окно от 1280×800.

Прогресс сохраняется локально: IndexedDB → localStorage → память
(каскад выбирается автоматически, текущий режим показан в панели «Профиль»).
Если браузер запрещает хранилище для `file://`, тренажёр всё равно работает,
но прогресс живёт до перезагрузки страницы — выгрузите его кнопкой «Экспорт».

Данные разложены по разделам: `settings`, `userProgress`, `learningHistory`,
`srsCards`, `terminalState`. Каждое чтение проходит проверку схемой
(`js/core/schema.js`): повреждённые, частичные и данные старой версии
приводятся к рабочему виду, а не роняют приложение. Профиль версии 1
переносится в новую схему автоматически при первом запуске.

## Как устроено обучение

Цикл один и тот же, как на работе:

```
инцидент → диагностика командами → гипотеза → правка конфигурации → проверка → разбор
```

* **Терминал** — центральный элемент. Команды исполняются в виртуальной модели
  Linux: интерфейсы, адреса, маршруты, ARP, сокеты, firewall, DNS, DHCP, systemd.
  Любая поломка видна во всех командах согласованно: `DROP` даёт таймаут,
  `REJECT` — Connection refused, неверный шлюз — «Destination Host Unreachable»,
  узкий MTU с заглушенным ICMP — зависание крупных передач.
* **Задание** (правая панель) — постановка, чеклист проверки, шаги диагностики,
  подсказки по уровням.
* **Разбор** — после решения: почему были именно такие симптомы, какие команды
  нужны, что вы пропустили, короткая теория и похожая задача для закрепления.
* **Навыки и повторение** — 13 навыков с уровнями Beginner → Expert; уровень
  считается по результатам лабораторий (объём × качество × сложность ×
  самостоятельность), а ошибки и пропущенные шаги попадают в очередь
  интервального повторения.

Режимы: Обучение, Практика, Экзамен, Troubleshooting (инцидент без описания
симптомов), Quick Practice (5–10 минут по слабым темам), Command Trainer
(тренировка команд и флагов).

Повторный запуск лаборатории выдаёт **другой вариант поломки** — заучить ответ
нельзя.

## Быстрый старт в терминале

```
lab list                 список лабораторий
lab start lab01          начать
check                    проверить решение (Ctrl+Enter)
hint                     подсказка (F2)
reset                    вернуть исходное состояние (F5)
connect gw               перейти на другой виртуальный хост
hosts                    все узлы топологии
help / man ip            справка
selftest                 самопроверка движка
```

Горячие клавиши целиком — клавиша `?` или кнопка `?` в верхней строке.

## Топология

```
srv1 / app1 / ns1 ──[LAN 192.168.10.0/24]── gw ──[203.0.113.0/30]── isp ── Интернет
                                            │                              (8.8.8.8, web, mirror)
                                      [10.99.0.0/30] ── rtr2 ──[10.20.5.0/24]── branch-srv
```

Консоль есть у `srv1` (основной), `app1`, `ns1`, `gw`, `branch-srv` —
переключение селектором в верхней строке, командой `connect <host>`,
через `ssh user@host` или кликом по узлу на схеме.

## Структура кода

```
index.html            порядок <script> = порядок инициализации
css/                  base · layout · terminal · components
js/core/              namespace, eventbus, util (IPv4/IPv6/CIDR, лимиты),
                      errors (централизованная обработка), schema (валидация
                      сохранённых данных), storage (разделы + миграции)
js/vm/                виртуальная машина и сеть:
                      vfs, users, process, netstack, firewall, packet,
                      dns, dhcp, services, capture, netcfg, machine,
                      topology, world
js/shell/             lexer → parser → expand → executor, completion,
                      history, man
js/commands/          registry + cmdlib (общие помощники) + команды по группам (fs, text, sys, systemd,
                      apt, net_ip, net_diag, net_dns, net_cfg, net_fw,
                      net_capture, services_cmd, misc)
js/labs/              engine, checks, lab01…lab10, pool (короткие задания)
js/learn/             skills, progress, srs, modes, theory, debrief
js/ui/                dom (безопасное построение DOM), terminal, панели,
                      палитра, шорткаты, app
js/dev/selftest.js    ~290 проверок движка
```

### Безопасность

* Вся работа происходит в виртуальной песочнице: у приложения нет ни `eval`,
  ни `new Function`, ни `fetch`/XHR/WebSocket, ни доступа к реальной ФС.
  `rm -rf /` удаляет файлы только внутри виртуальной машины, а `reset`
  возвращает их обратно.
* В DOM текст попадает исключительно через `textContent`/`createElement`
  (`js/ui/dom.js`): вывод команды, имя файла, имя хоста и импортированный
  профиль не могут стать разметкой или скриптом.
* В `index.html` объявлена строгая CSP: `script-src 'self' file:` без
  `unsafe-inline`/`unsafe-eval`, `connect-src 'none'`, `object-src 'none'`.
  Встроенных скриптов и `style`-атрибутов в документе нет.
  `style-src` оставлен с `'unsafe-inline'` намеренно — на `file://` браузеры
  по-разному сопоставляют origin, и это единственное послабление,
  не влияющее на исполнение кода.
* Ключи `__proto__`, `constructor`, `prototype` отбрасываются при разборе YAML,
  импорте профиля и присваивании переменных окружения.
* Пользовательский ввод ограничен: длина строки, число звеньев конвейера,
  объём вывода, размер файла, число процессов, сокетов, пакетов и записей
  журнала (`NET.util.LIMITS`).

Ключевые решения:

* **Никаких ES-модулей.** На `file://` Chrome блокирует `<script type="module">`
  политикой CORS, поэтому все файлы — classic scripts в IIFE с общим
  namespace `window.NET`.
* **Никаких внешних JSON.** `fetch()` к локальным файлам на `file://` запрещён,
  поэтому все данные (лаборатории, топологии, теория, задания) — это JS-объекты.
* **Одна модель на все команды.** `ip`, `netplan`, `nmcli`, `dhclient` меняют
  один и тот же `netstack`; `ufw`, `iptables`, `nft` — один и тот же netfilter;
  `ping`, `traceroute`, `curl`, `dig`, `ssh`, `tcpdump` читают один и тот же
  движок пакетов. Поэтому не важно, чем пользователь чинит сеть — важен результат.

## Как расширять

**Новая команда** — файл в `js/commands/` и строка `<script>` в `index.html`:

```js
NET.commands.register({
  name: 'mycmd', category: 'net', summary: 'что делает', usage: 'mycmd [-f] ARG',
  complete: function (ctx, word, argv, h) { return h.ifaces(ctx); },
  run: function (ctx) {                 // можно вернуть Promise
    var p = NET.cmdutil.parse(ctx.argv, { bool: ['f'], value: ['n'] });
    ctx.line('вывод');                  // stdout
    ctx.errLine('ошибка');              // stderr
    return 0;                           // exit code
  }
});
```

В `ctx` доступны: `machine`, `world`, `vfs`, `net`, `fsctx` (права), `user`,
`isRoot`, `cwd`, `env`, `stdin`, `sleep(ms)`, `aborted()`.

**Новая лаборатория** — файл в `js/labs/`:

```js
NET.labs.register({
  id: 'lab11', title: '…', difficulty: 3, skills: ['routing', 'troubleshooting'],
  brief: 'что известно инженеру', goal: 'что должно заработать',
  setup: function (world, h) { /* внести поломку; h.writeNetplan/applyNetplan/log */ },
  keySteps: [{ id: 'route', title: 'Посмотреть маршруты', match: /^ip\s+r/ }],
  checks: [NET.checks.canPing('srv1', '8.8.8.8')],
  hints: ['направление', 'сужение', 'решение'],
  debrief: { why: '…', commands: [['ip route', 'зачем']], theory: 'routing-basics' },
  mutations: [{ name: 'другой вариант', setup: function (w, h) { /* … */ } }]
});
```

Библиотека проверок в `js/labs/checks.js`: `canPing`, `tcpOpen`, `routeExists`,
`defaultVia`, `ifaceUp`, `hasAddr`, `addrInSubnet`, `addrIsDynamic`,
`portListening`, `serviceActive`, `resolves`, `mtuIs`, `pathMtuOk`,
`firewallAllows`, `survivesReboot`, `usedCommand`, `custom`.

**Новая топология** — `NET.registries.topologies` в `js/vm/topology.js`:
L2-сегменты (их роль играют коммутаторы), машины с железом, постоянной
конфигурацией и сервисами, плюс раскладка для SVG-схемы.

**Новая теория** — карточка в `js/learn/theory.js`, ссылка из `debrief.theory`.

## Проверка после изменений

```
selftest        в терминале приложения (или index.html?selftest=1)
```

Проходит ~270 проверок: longest prefix match, ARP при неверной маске,
отсутствие default route, MTU blackhole, DROP против REJECT, DNS SERVFAIL и
таймауты, аренда DHCP, persistence после reboot, права VFS, pipeline и
exit codes, расчёт уровней, интервалы повторения, а также то, что каждый
вариант каждой лаборатории действительно создаёт поломку.

Если под рукой есть Node.js, в `tools/` лежат дополнительные прогоны (вывод
команд, прохождение всех лабораторий и их вариантов, схема и миграции
хранилища, загрузка интерфейса, безопасность) — см. `tools/README.md`.
Всего около 690 автоматических проверок. Для работы самого тренажёра
Node.js не нужен.
