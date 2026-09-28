/*
 * Безопасность: XSS, инъекции, prototype pollution, изоляция песочницы,
 * огромный и «злой» ввод, целостность прогресса, автономность.
 *
 * Тесты гоняют настоящее приложение (движок + интерфейс против заглушки DOM)
 * и проверяют результат в дереве документа, а не наличие строк в исходниках.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { docObj, parseHtml, windowApi } = require(path.join(__dirname, 'domshim.js'));
const ROOT = process.argv[2] || '.';
const engineFiles = JSON.parse(fs.readFileSync(path.join(__dirname, 'files.json'), 'utf8'));
const uiFiles = ['ui/dom.js', 'ui/notify.js', 'ui/pager.js', 'ui/terminal.js', 'ui/panel_task.js',
  'ui/panel_labs.js', 'ui/panel_progress.js', 'ui/panel_debrief.js', 'ui/panel_topology.js', 'ui/panel_lesson.js', 'ui/panel_quiz.js',
  'ui/panel_history.js', 'ui/palette.js', 'ui/shortcuts.js', 'ui/app.js'];

parseHtml(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));

const consoleErrors = [];
const sandbox = {
  console: { log: console.log, warn: () => {}, error: (...a) => consoleErrors.push(a.join(' ')) },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval, Promise, Date, Math, JSON, RegExp,
  parseInt, parseFloat, isNaN, String, Number, Object, Array, Error, Set, Map,
  document: docObj, location: { search: '' },
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  FileReader: function () {}, getSelection: () => '', confirm: () => true, prompt: () => null,
  addEventListener: windowApi.addEventListener, removeEventListener: windowApi.removeEventListener,
  requestAnimationFrame: windowApi.requestAnimationFrame
};
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
for (const f of engineFiles.concat(uiFiles)) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
}
const NET = sandbox.NET;

let fails = 0, passes = 0;
const ok = (c, t, d) => { if (c) passes++; else { fails++; console.log('FAIL  ' + t + (d ? '  [' + d + ']' : '')); } };
const $ = id => docObj.getElementById(id);

/* ---------- помощники ---------- */

function allElements() {
  const out = [];
  (function walk(n) { n.childNodes.forEach(c => { out.push(c); walk(c); }); })(docObj.body);
  return out;
}
function hasTag(tag) {
  return allElements().some(e => e.tagName === tag.toUpperCase());
}
function bodyText() { return docObj.body.textContent; }

const XSS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg/onload=alert(1)>',
  "javascript:alert(1)",
  '<iframe src=javascript:alert(1)>',
  '<b onmouseover=alert(1)>hover</b>',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '</span><img src=1 onerror=alert(1)><span>'
];
/*
 * Точная проверка: разметка из данных не должна превращаться в элементы.
 * <script src="js/..."> и <svg> схемы — легитимная часть страницы, поэтому
 * смотрим на признаки инъекции: обработчики событий, инлайновые скрипты,
 * загрузчики внешнего контента.
 */
const FORBIDDEN_TAGS = ['IMG', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT[onerror]'];
const EVENT_ATTRS = ['onerror', 'onload', 'onmouseover', 'onclick', 'onfocus', 'onanimationstart'];

function injectionEvidence() {
  const problems = [];
  allElements().forEach(e => {
    if (FORBIDDEN_TAGS.indexOf(e.tagName) >= 0) problems.push('элемент ' + e.tagName);
    EVENT_ATTRS.forEach(a => {
      if (e.attributes && e.attributes[a] !== undefined) problems.push(e.tagName + '[' + a + ']');
    });
    if (e.tagName === 'SCRIPT') {
      const src = e.getAttribute('src') || '';
      if (!/^js\//.test(src)) problems.push('скрипт с src="' + src + '"');
      if ((e._text || '').trim()) problems.push('встроенный скрипт');
    }
    if (e.tagName === 'A') {
      const href = e.getAttribute('href') || '';
      if (/^javascript:/i.test(href)) problems.push('ссылка javascript:');
    }
  });
  return problems;
}

function noDangerousTags(where) {
  const problems = injectionEvidence();
  ok(problems.length === 0, 'XSS: ' + where + ' — разметка из данных не стала элементами',
    problems.slice(0, 4).join(', '));
}

(async () => {
  await NET.ui.app.boot();
  const term = NET.ui.terminal;
  const session = NET.ui.app.session();

  /* ============ 1. XSS через вывод терминала ============ */
  for (const payload of XSS) {
    await term.run("echo '" + payload.replace(/'/g, "") + "'");
  }
  noDangerousTags('вывод echo с полезной нагрузкой');
  ok($('term-out').textContent.indexOf('onerror') >= 0,
    'XSS: полезная нагрузка отображается как текст, а не исполняется');

  /* имена файлов */
  await term.run('mkdir -p /tmp/x && touch "/tmp/x/<img src=q onerror=alert(1)>.txt"');
  await term.run('ls -l /tmp/x');
  await term.run('find /tmp/x -type f');
  await term.run('stat "/tmp/x/<img src=q onerror=alert(1)>.txt"');
  noDangerousTags('имя файла в выводе ls/find/stat');

  /* содержимое файла через pager */
  await term.run('printf "<script>alert(1)</script>\\n" > /tmp/x/p.html');
  await term.run('less /tmp/x/p.html');
  ok(!$('pager').classList.contains('hidden'), 'pager открылся');
  ok($('pager-body').textContent.indexOf('<script>') >= 0, 'XSS: pager показывает разметку как текст');
  noDangerousTags('содержимое файла в pager');
  NET.ui.pager.close();

  /* имя хоста попадает в prompt, топбар и схему */
  await term.run('sudo hostname "<b onmouseover=alert(1)>pwn</b>"');
  term.refreshPrompt();
  NET.ui.app.updateTopbar();
  NET.ui.task.render();
  NET.ui.topology.render();
  noDangerousTags('имя хоста в prompt/панелях/схеме');
  ok($('term-prompt').textContent.indexOf('<b ') >= 0, 'XSS: имя хоста отображается текстом');
  await term.run('sudo hostname ubuntu');

  /* уведомления, палитра, редактор */
  NET.ui.notify.err(XSS[0], XSS[1]);
  NET.ui.palette.rebuild();
  NET.ui.palette.open();
  NET.ui.palette.filter('<img src=x onerror=alert(1)>');
  NET.ui.palette.close();
  NET.ui.editor.open('/tmp/x/p.html', '<script>alert(1)</script>', 'root');
  noDangerousTags('уведомление, палитра, редактор');
  NET.ui.editor.close();

  /* задание и разбор: полезная нагрузка в данных задачи */
  NET.registries.tasks.push({
    id: 'xss-task', type: 'state', skill: 'cli', difficulty: 1,
    prompt: 'Задача <img src=x onerror=alert(1)> проверка',
    hint: '<script>alert(1)</script>', solution: '<b>x</b>',
    check: () => ({ ok: false, detail: '<iframe src=javascript:alert(1)>' })
  });
  NET.ui.task.quick.task = NET.taskPool.get('xss-task');
  NET.ui.task.quick.startedAt = Date.now();
  NET.ui.task.quick.hintShown = true;
  NET.ui.task.render();
  noDangerousTags('панель задания с полезной нагрузкой в данных');
  NET.ui.task.quick.stop();

  /* история обучения из импортированного профиля */
  await NET.storage.importAll({
    data: {
      learningHistory: {
        version: 2,
        entries: [{ at: Date.now(), kind: 'lab', id: 'x', title: '<img src=x onerror=alert(1)> лаба', score: 50 }]
      }
    }
  });
  await NET.progress.load();
  NET.ui.history.render();
  noDangerousTags('история обучения из импортированного файла');
  ok(bodyText().indexOf('onerror=alert(1)> лаба') >= 0, 'XSS: заголовок из файла показан текстом');

  /* ============ 2. JavaScript-инъекции ============ */
  ok(NET.commands.get('eval') === null && NET.commands.get('node') === null,
    'инъекции: в реестре нет команд исполнения JavaScript');
  const before = consoleErrors.length;
  await term.run('echo $(alert(1))');
  await term.run('echo `process.exit(1)`');
  await term.run('$(require("fs").writeFileSync("/tmp/pwned","1"))');
  ok(!fs.existsSync('/tmp/pwned'), 'инъекции: подстановка команд не выполняет JavaScript хоста');
  ok($('term-out').textContent.indexOf('command not found') >= 0,
    'инъекции: $(...) трактуется как команда оболочки, а не как код',
    $('term-out').textContent.slice(-120));

  /* исходники не содержат динамического исполнения */
  const srcFiles = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir)).forEach(name => {
      const rel = path.join(dir, name);
      const st = fs.statSync(path.join(ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if (name.endsWith('.js') || name.endsWith('.html')) srcFiles.push(rel);
    });
  })('js');
  srcFiles.push('index.html');
  const stripComments = t => t
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const badApi = [];
  srcFiles.forEach(rel => {
    const text = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    [/\beval\s*\(/, /new\s+Function\s*\(/, /\binnerHTML\s*=/, /outerHTML/, /insertAdjacentHTML/,
      /document\.write/, /setTimeout\s*\(\s*['"]/, /setInterval\s*\(\s*['"]/].forEach(re => {
      if (re.test(text)) badApi.push(rel + ' ~ ' + re);
    });
  });
  ok(badApi.length === 0, 'инъекции: в коде нет eval/new Function/innerHTML/document.write', badApi.join('; '));

  /* ============ 3. Изоляция песочницы ============ */
  const sentinel = path.join(require('os').tmpdir(), 'lnet-sentinel-' + Date.now() + '.txt');
  fs.writeFileSync(sentinel, 'важный файл пользователя');
  await term.run('sudo rm -rf /');
  await term.run('sudo rm -rf /*');
  await term.run('sudo dd if=/dev/zero of=/dev/sda');
  await term.run('sudo mkfs.ext4 /dev/sda1');
  await term.run('sudo shutdown -h now');
  await term.run(':(){ :|:& };:');
  ok(fs.existsSync(sentinel), 'песочница: rm -rf / не тронул реальную файловую систему');
  ok(fs.readFileSync(sentinel, 'utf8') === 'важный файл пользователя', 'песочница: реальный файл не изменён');
  fs.unlinkSync(sentinel);
  ok(typeof sandbox.require === 'undefined' && typeof sandbox.process === 'undefined',
    'песочница: код приложения не видит require/process');

  /* мир восстанавливается после разрушительных команд */
  NET.world.rebuild();
  ok(!!NET.world.get('srv1').vfs.get('/etc/hostname', NET.ROOTCTX),
    'песочница: мир пересобирается после разрушительных команд');

  /* выход за корень виртуальной ФС невозможен */
  const esc = await NET.shell.capture(session, 'cd ../../../../../.. && pwd');
  ok(esc.stdout.trim() === '/', 'песочница: путь не выходит за корень виртуальной ФС', esc.stdout.trim());
  const trav = await NET.shell.capture(session, 'cat ../../../../../../etc/hostname');
  ok(trav.stdout.trim() === NET.world.machine().hostname,
    'песочница: обход каталогов ведёт в виртуальный /etc, а не в хостовый');

  /* ============ 4. Prototype pollution ============ */
  const pollutionProbes = [
    '{"__proto__":{"polluted":true}}',
    '{"constructor":{"prototype":{"polluted2":true}}}',
    '{"version":2,"labs":{"__proto__":{"solved":true}},"skills":{"__proto__":{"solved":99}}}'
  ];
  for (const raw of pollutionProbes) {
    NET.schema.validate('userProgress', JSON.parse(raw));
    await NET.storage.importAll({ data: { userProgress: JSON.parse(raw) } });
  }
  ok({}.polluted === undefined && {}.polluted2 === undefined && [].polluted === undefined,
    'pollution: импорт и валидация не загрязняют Object.prototype');

  await term.run('export __proto__=1');
  await term.run('export constructor=2');
  ok({}.constructor === Object, 'pollution: export с опасным именем не меняет прототип');
  const envProbe = await NET.shell.capture(session, 'echo x${HOME}x');
  ok(envProbe.stdout.indexOf('/home/') >= 0, 'pollution: объект окружения остался рабочим', envProbe.stdout.trim());

  /* netplan YAML с опасными ключами */
  const yaml = NET.netcfg.parseYaml('network:\n  version: 2\n  __proto__:\n    x: 1\n  constructor:\n    y: 2\n  ethernets:\n    ens33:\n      addresses: [10.0.0.9/24]\n');
  ok(yaml.errors.some(e => /недопустимый ключ/.test(e.msg)), 'pollution: YAML-парсер отвергает __proto__ и constructor');
  ok({}.x === undefined && {}.y === undefined, 'pollution: разбор YAML не загрязняет прототипы');
  ok(yaml.doc.network.ethernets.ens33.addresses[0] === '10.0.0.9/24', 'YAML: остальная конфигурация разобрана');

  /* злой netplan применяется без падения */
  const srv = NET.world.get('srv1');
  srv.vfs.write('/etc/netplan/99-evil.yaml',
    'network:\n  version: 2\n  ethernets:\n    __proto__:\n      addresses: [1.2.3.4/24]\n    ens33:\n      addresses: [192.168.10.20/24]\n',
    NET.ROOTCTX);
  const applied = await NET.shell.capture(session, 'sudo netplan apply');
  ok(!/internal error/.test(applied.stdout + applied.stderr), 'YAML: применение враждебного конфига не даёт internal error');
  srv.vfs.unlink('/etc/netplan/99-evil.yaml', NET.ROOTCTX);

  /* ============ 5. Огромный и странный ввод ============ */
  term.clear();
  const hugeCode = await NET.shell.run(session, 'echo ' + 'A'.repeat(20000), {});
  term.flush();
  ok(/Argument list too long/.test($('term-out').textContent) && hugeCode === 126,
    'ввод: слишком длинная строка отклоняется, а не обрабатывается', 'exit ' + hugeCode);
  term.clear();
  const pipeCode = await NET.shell.run(session, Array(30).fill('echo x').join(' | '), {});
  term.flush();
  ok(/конвейер/.test($('term-out').textContent), 'ввод: слишком длинный конвейер отклоняется',
    'exit ' + pipeCode);
  const nested = await NET.shell.capture(session, 'echo $(echo $(echo $(echo $(echo $(echo deep)))))');
  ok(nested.code === 0 || nested.code === 1, 'ввод: глубокая подстановка не вешает оболочку');

  await term.run('printf "a\\rb\\tc\\n" > /tmp/ctrl.txt');
  const ctrlOut = await NET.shell.capture(session, 'cat /tmp/ctrl.txt');
  ok(ctrlOut.code === 0, 'ввод: управляющие символы читаются без ошибки');
  term.clear();
  term.write('ESC:\u001b[31mred\u0000NUL‮bidi\r\n');
  term.flush();
  const rendered = $('term-out').textContent;
  ok(rendered.indexOf('\u0000') < 0 && rendered.indexOf('\u001b') < 0,
    'ввод: управляющие символы не попадают в DOM как есть');
  ok(rendered.indexOf('^[') >= 0 && rendered.indexOf('�') >= 0,
    'ввод: ESC показан как ^[, bidi-переопределение заменено');

  const unicode = await NET.shell.capture(session, 'mkdir -p "/tmp/пап ка😀" && ls /tmp');
  ok(unicode.stdout.indexOf('пап ка😀') >= 0, 'ввод: unicode в путях работает');
  const empty = await NET.shell.capture(session, '   ');
  ok(empty.code === 0, 'ввод: пустая строка безопасна');
  for (const weird of ['|', '||', '&&', '>', '<', '2>', '"', "'", '$(', '`', ';;', '!!!', '../..', '-', '--']) {
    const r = await NET.shell.capture(session, weird);
    ok(typeof r.code === 'number', 'ввод: «' + weird + '» обработан без исключения');
  }

  /* ============ 6. Целостность прогресса ============ */
  await NET.progress.reset();
  NET.labs.start('lab01', { variant: 0 });
  const echoed = await NET.shell.capture(session, 'echo "ip route add default via 192.168.10.1 dev ens33"');
  let res = NET.labs.check();
  ok(!res.solved, 'прогресс: печать правильной команды в echo не засчитывается');
  const noSudo = await NET.shell.capture(session, 'ip route add default via 192.168.10.1 dev ens33');
  ok(noSudo.code !== 0, 'прогресс: без прав команда не выполняется');
  res = NET.labs.check();
  ok(!res.solved, 'прогресс: неудачная команда не засчитывается');
  ok(!NET.progress.isLabSolved('lab01'), 'прогресс: лаборатория не отмечена решённой');
  await NET.shell.run(session, 'sudo ip route add default via 192.168.10.1 dev ens33', {});
  res = NET.labs.check();
  ok(res.solved && NET.progress.isLabSolved('lab01'), 'прогресс: реальное изменение состояния засчитано');

  /* подделка прогресса через хранилище не проходит валидацию как «решено» */
  await NET.storage.importAll({ data: { userProgress: { version: 2, labs: { lab07: { solved: 'ага', best: '1000' } }, skills: {} } } });
  await NET.progress.load();
  ok(NET.progress.isLabSolved('lab07') === false, 'прогресс: мусор в хранилище не отмечает лабораторию решённой');
  const best = NET.progress.get().labs.lab07.best;
  ok(best >= 0 && best <= 100, 'прогресс: оценка ограничена диапазоном 0..100', String(best));

  /* ============ 7. Автономность ============ */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const externals = (html.match(/(?:src|href)="(?!js\/|css\/)[^"]*"/g) || []);
  ok(externals.length === 0, 'автономность: в index.html нет внешних ресурсов', externals.join(','));
  ok(/Content-Security-Policy/.test(html), 'автономность: CSP объявлена в документе');
  ok(/connect-src 'none'/.test(html), 'автономность: CSP запрещает сетевые соединения');
  ok(!/<script>[\s\S]*?<\/script>/.test(html.replace(/<script src=[^>]*><\/script>/g, '')),
    'CSP: в документе нет встроенных скриптов');
  ok(!/\sstyle="/.test(html), 'CSP: в документе нет инлайновых style-атрибутов');
  const netApi = [];
  srcFiles.forEach(rel => {
    const text = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /EventSource/, /navigator\.sendBeacon/,
      /importScripts/, /type="module"/].forEach(re => { if (re.test(text)) netApi.push(rel + ' ~ ' + re); });
  });
  ok(netApi.length === 0, 'автономность: нет обращений к сети из кода', netApi.join('; '));

  /* ============ 8. Ошибки не рвут приложение ============ */
  let reported = 0;
  NET.bus.on('error:reported', () => reported++);
  NET.bus.on('probe:boom', () => { throw new Error('обработчик упал'); });
  let after = false;
  NET.bus.on('probe:boom', () => { after = true; });
  NET.bus.emit('probe:boom', {});
  ok(after, 'ошибки: исключение в одном обработчике не отменяет остальные');
  ok(reported > 0, 'ошибки: сбой обработчика попал в журнал ошибок');
  const badCmd = NET.commands.register({
    name: '__boom', category: 'sys', summary: '', run: function () { throw new Error('намеренный сбой'); }
  });
  const boom = await NET.shell.capture(session, '__boom');
  ok(boom.code === 1, 'ошибки: падение команды даёт ненулевой код, а не исключение наружу');
  const stillWorks = await NET.shell.capture(session, 'echo alive');
  ok(stillWorks.stdout.trim() === 'alive', 'ошибки: оболочка продолжает работать после сбоя команды');
  ok(NET.errors.log().length > 0, 'ошибки: журнал ошибок доступен для отчёта');

  console.log('\n===== security: ' + passes + ' PASS, ' + fails + ' FAIL =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
