/*
 * Заготовка новой лабораторной: два файла и регистрация в index.html и tools/files.json.
 *
 *   node tools/new-lab.js lab16 "Название задачи" 3     — диагностика
 *   node tools/new-lab.js sec06 "Название задачи" 3     — раздел «Безопасность»
 *   node tools/new-lab.js --register js/learn/content/lab16.js  — только зарегистрировать файл
 *
 * Префикс id задаёт раздел: labNN — диагностика, secNN — безопасность
 * (в шаблон добавляется track: 'security').
 *
 * Создаются:
 *   js/labs/<id>.js           — сценарий: поломка, проверки, подсказки, разбор, мутации, эталон solution;
 *   js/learn/content/<id>.js  — теория: врезка, урок, методическая часть, тест.
 * В заготовках стоят метки TODO. Пока они есть, селфтест падает на
 * «контракте лабораторий» и подсказывает, что ещё не заполнено.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const FILES_JSON = path.join(__dirname, 'files.json');
const INDEX = path.join(ROOT, 'index.html');

function die(msg) { console.error('new-lab: ' + msg); process.exit(1); }

/* Куда вставлять: лаборатории — после последней labNN.js, теория — после последнего
   файла learn/content/ (или после learn/debrief.js, если их ещё нет). */
function anchorFor(rel, list) {
  const isLab = /^labs\/(lab|sec)\d+\.js$/.test(rel);
  const isContent = /^learn\/content\//.test(rel);
  if (!isLab && !isContent) die('неизвестный тип файла: ' + rel + ' (ожидается labs/labNN.js, labs/secNN.js или learn/content/*.js)');
  const same = list.filter(f => isLab ? /^labs\/(lab|sec)\d+\.js$/.test(f) : /^learn\/content\//.test(f));
  if (same.length) return same[same.length - 1];
  return isLab ? 'labs/engine.js' : 'learn/debrief.js';
}

function register(rel) {
  rel = rel.replace(/^js\//, '');
  if (!fs.existsSync(path.join(ROOT, 'js', rel))) die('нет файла js/' + rel);

  const list = JSON.parse(fs.readFileSync(FILES_JSON, 'utf8'));
  if (list.indexOf(rel) < 0) {
    const anchor = anchorFor(rel, list);
    list.splice(list.indexOf(anchor) + 1, 0, rel);
    fs.writeFileSync(FILES_JSON, '[\n' + list.map(f => JSON.stringify(f)).join(',\n') + '\n]\n');
    console.log('  tools/files.json  + ' + rel + '  (после ' + anchor + ')');
  }

  let html = fs.readFileSync(INDEX, 'utf8');
  const tag = f => '<script src="js/' + f + '"></script>';
  if (html.indexOf(tag(rel)) < 0) {
    const anchor = anchorFor(rel, list.filter(f => f !== rel && html.indexOf(tag(f)) >= 0));
    const at = html.indexOf(tag(anchor));
    if (at < 0) die('в index.html не найден ' + tag(anchor));
    const end = html.indexOf('\n', at) + 1;
    html = html.slice(0, end) + tag(rel) + '\n' + html.slice(end);
    fs.writeFileSync(INDEX, html);
    console.log('  index.html        + ' + tag(rel));
  }
}

function labTemplate(id, title, difficulty) {
  const sec = id.startsWith('sec');
  const num = id.replace(/^(lab|sec)/, '');
  const head = sec
    ? `/*
 * Sec ${num} — TODO: одна строка о сути атаки.
 * Задача оборонительная: обнаружить, отразить, закрыть возможность повторить.
 */`
    : `/* Lab ${num} — TODO: одна строка о сути поломки. */`;
  return `${head}
(function (NET) {
  'use strict';
  var C = NET.checks;

  NET.labs.register({
    id: '${id}',${sec ? "\n    track: 'security',   // раздел курса; без поля — диагностика" : ''}
    title: ${JSON.stringify(title)},
    difficulty: ${difficulty},
    skills: [${sec ? "'security', 'troubleshooting'" : "'troubleshooting', 'networking'"}],   // id из js/learn/skills.js
    topology: 'campus',
    brief: 'TODO: жалоба пользователя — симптомы, а не причина.\\n' +
      'Что известно, какие хосты доступны (connect gw / app1).',
    goal: 'TODO: проверяемый результат одной строкой.',

    /*
     * Поломка — изменение состояния мира. Помощники h (js/labs/engine.js):
     *   h.netplanPatch('srv1', { addresses: ['192.168.10.20/28'] })  — netplan с правкой, записан и применён
     *   h.writeFile / h.appendFile / h.editFile(host, path, ...)     — файлы конфигурации
     *   h.sysctl('gw', 'net.ipv4.ip_forward', 0, '99-x.conf')        — параметр ядра (+ файл в /etc/sysctl.d)
     *   h.log(host, unit, msg)                                        — запись в журнал для правдоподобия
     *   world.get(host).services.stop('nginx'), .fw.addRule(...), .net.setLink(...)
     *
     * Для раздела «Безопасность» (всё моделируется внутри приложения):
     *   h.fail2ban('srv1', { enabled: false, start: false })          — установить fail2ban
     *   h.bruteForce('srv1', '198.51.100.66', 30, { user: 'root' })   — следы подбора в журнале sshd
     *   h.flood('srv1', { kind: 'syn'|'conn', port: 443, sources: [] }) — сервис под потоком
     *   h.accessLog('srv1', [{ ip, path, status, size, ua }])         — строки /var/log/nginx/access.log
     *   h.service('srv1', { name, ports, configFile, bindFrom })      — служба с адресом из конфигурации
     *   h.addUser('srv1', { name: 'support', uid: 0, group: 'root' }) — посторонняя учётная запись
     * Внешний источник трафика — хост attacker (198.51.100.0/24), адрес .200 у администратора.
     */
    setup: function (world, h) {
      // TODO
    },

    /* Шаги диагностики: засчитываются по введённым командам и влияют на оценку. */
    keySteps: [
      { id: 'TODO', title: 'TODO: что проверить', match: /^ip\\s+(-\\w+\\s+)*(a|addr)\\b/ }
    ],

    /* Проверки смотрят на состояние мира (js/labs/checks.js), а не на текст команд. */
    checks: [
      // C.canPing('srv1', '8.8.8.8', 'Интернет'),
      // C.tcpOpen('app1', '192.168.10.20', 443, 'HTTPS с клиента'),
      // C.survivesReboot('srv1', [ ... ])
      //
      // Раздел «Безопасность»: C.tcpClosed (в т.ч. с { srcIP }), C.ipBanned, C.serviceEnabled,
      // C.sshdOption, C.sysctlIs, C.ufwActive, C.portClosed, C.noExtraRootUsers, C.userAbsent,
      // C.noExtraSuid, C.fileAbsent, C.fileHas, C.modeAtMost, C.httpStatus.
      // Обязательно проверяйте и то, что легитимный доступ сохранён.
    ],

    /* Эталонное решение: команды оболочки с диагностикой. Прогоняется
       tools/run-lab-walkthrough.js — таблицы в тестах править не нужно. */
    solution: [
      // 'ip -br a',
    ],

    hints: [
      'TODO: подсказка 1 — куда смотреть',
      'TODO: подсказка 2 — что там не так',
      'TODO: подсказка 3 — готовая команда исправления'
    ],

    debrief: {
      why: 'TODO: почему так получилось — механизм, а не пересказ решения.',
      commands: [
        ['TODO команда', 'что она показала']
      ],
      theory: '${id}-TODO',   // id врезки из js/learn/content/${id}.js
      pitfalls: ['TODO: типичная ошибка']
    },

    /* Мутации: та же тема, другая поломка. У каждой — setup, brief, hints, solution
       (и при необходимости свои checks/debrief). Прогоняются run-lab-mutations.js. */
    mutations: [
      // {
      //   name: 'короткое имя варианта',
      //   brief: '...',
      //   setup: function (world, h) { ... },
      //   solution: ['...'],
      //   hints: ['...', '...']
      // }
    ]
  });
})(window.NET);
`;
}

function contentTemplate(id, title) {
  const q = n => `    {
      cmd: 'ip', q: 'TODO: вопрос ${n}?',
      options: ['TODO верный ответ ${n}', 'TODO неверный ${n}.1', 'TODO неверный ${n}.2'],
      answer: 0, explain: 'TODO: почему верный ответ верный.'
    }`;
  return `/* Теория к ${id} «${title}»: врезка, урок, методическая часть и тест. */
(function (NET) {
  'use strict';

  var H = NET.method.helpers;   // H.netplanWrite(H.netplanYaml({ addr, dns })) — запись netplan одной командой

  /* Короткая врезка — показывается в разборе после задачи (debrief.theory). */
  NET.theory.add({
    id: '${id}-TODO', title: 'TODO', skill: 'networking',
    text: ['TODO: 3–5 коротких утверждений, по одному на строку.'].join('\\n'),
    commands: ['ip -br a']
  });

  /* Развёрнутый урок — вкладка «Теория» и команда lesson. Абзацы не короче 80 символов,
     команды в cmds должны быть реализованы в тренажёре. Порядок разделов: суть темы
     простыми словами (с определением терминов) → как это работает → пример на стенде →
     практика → диагностика. scheme — схема псевдографикой на адресах стенда (строки
     не длиннее 72 символов), after — абзацы после схемы; вывод в out — реальный. */
  NET.lessons.register({
    id: '${id}',
    lab: '${id}',
    title: 'TODO: тема урока',
    skill: 'networking',
    minutes: 8,
    lead: 'TODO: зачем это инженеру (не короче 150 символов).',
    sections: [
      {
        h: 'Суть темы: TODO',
        p: ['TODO: что это, зачем и какую задачу решает; термины — при первом упоминании'],
        scheme: { title: 'TODO', text: ['TODO: схема механизма на узлах стенда'].join('\n') }
      },
      { h: 'TODO: как это работает', p: ['TODO'], cmds: [['ip -br a', 'TODO']] },
      { h: 'TODO: диагностика', p: ['TODO'] }
    ],
    pitfalls: ['TODO', 'TODO'],
    summary: ['TODO', 'TODO', 'TODO'],
    practice: 'TODO: переход к лабораторной без раскрытия решения.'
  });

  /* Методическая часть. practice выполняется на базовом варианте лабораторной,
     sees/absent сверяются с выводом (tools/run-lesson-practice.js); затем solution
     должно решить задачу. Сценарий — похожий случай, но не совпадающий с поломкой. */
  NET.method.add('${id}', {
    minutes: 7,
    commands: [
      { cmd: 'ip -br a', shows: 'TODO', why: 'TODO', read: [['TODO признак', 'TODO значение']] }
      // не меньше 5 команд
    ],
    scenario: {
      title: 'TODO', symptom: 'TODO',
      hypotheses: ['TODO', 'TODO'],
      checks: [['команда', 'результат', 'вывод'], ['команда', 'результат', 'вывод']],
      localize: 'TODO', fix: [['TODO', 'TODO']], verify: ['TODO'], transfer: 'TODO'
    },
    practice: [
      { cmd: 'ip -br a', sees: 'TODO', expect: 'TODO', ask: 'TODO?' }
      // не меньше 4 шагов; практика ничего не чинит
    ],
    solution: {
      steps: [{ cmd: 'TODO', note: 'TODO' }],       // шаг с nano/vi требует поле run
      verify: [{ cmd: 'TODO', sees: 'TODO' }]
    },
    checklist: ['TODO', 'TODO', 'TODO', 'TODO', 'TODO'],
    questions: [
      { q: 'TODO?', a: 'TODO: содержательный ответ не короче 40 символов.' }
      // не меньше 4 вопросов
    ]
  });

  /* Тест: не меньше 8 вопросов, 3–5 вариантов, cmd — реализованная команда. */
  NET.quiz.add('${id}', [
${[1, 2, 3, 4, 5, 6, 7, 8].map(q).join(',\n')}
  ]);
})(window.NET);
`;
}

const args = process.argv.slice(2);
if (args[0] === '--register') {
  if (!args[1]) die('укажите файл: node tools/new-lab.js --register js/learn/content/lab16.js');
  register(args[1]);
  process.exit(0);
}

const [id, title, diffRaw] = args;
if (!id || !title) {
  console.log('Использование:\n  node tools/new-lab.js <labNN|secNN> "<название>" <сложность 1-5>\n' +
    '  node tools/new-lab.js --register <js/путь/к/файлу.js>');
  process.exit(1);
}
if (!/^(lab|sec)\d{2,}$/.test(id)) die('id должен иметь вид lab16 (диагностика) или sec06 (безопасность)');
const difficulty = parseInt(diffRaw || '1', 10);
if (!(difficulty >= 1 && difficulty <= 5)) die('сложность — целое от 1 до 5');

const labFile = path.join(ROOT, 'js', 'labs', id + '.js');
const contentFile = path.join(ROOT, 'js', 'learn', 'content', id + '.js');
[labFile, contentFile].forEach(f => { if (fs.existsSync(f)) die('файл уже существует: ' + path.relative(ROOT, f)); });

fs.mkdirSync(path.dirname(contentFile), { recursive: true });
fs.writeFileSync(labFile, labTemplate(id, title, difficulty));
fs.writeFileSync(contentFile, contentTemplate(id, title));
console.log('Созданы:\n  js/labs/' + id + '.js\n  js/learn/content/' + id + '.js');
register('labs/' + id + '.js');
register('learn/content/' + id + '.js');
console.log('\nДальше: заполните TODO и прогоните все проверки из tools/ (см. CLAUDE.md).\n' +
  'Селфтест покажет, чего не хватает: node tools/run-selftest.js .');
