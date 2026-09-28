/* Прогон UI-слоя против DOM-заглушки: boot, панели, терминал, топология */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { docObj, parseHtml, byId, windowApi } = require(path.join(__dirname, 'domshim.js'));
const ROOT = process.argv[2];

const engineFiles = JSON.parse(fs.readFileSync(path.join(__dirname, 'files.json'), 'utf8'));
const uiFiles = ['ui/dom.js', 'ui/notify.js', 'ui/pager.js', 'ui/terminal.js', 'ui/panel_task.js', 'ui/panel_labs.js',
  'ui/panel_progress.js', 'ui/panel_debrief.js', 'ui/panel_topology.js', 'ui/panel_lesson.js', 'ui/panel_quiz.js', 'ui/panel_history.js',
  'ui/palette.js', 'ui/shortcuts.js', 'ui/app.js'];

parseHtml(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'));

const errors = [];
const sandbox = {
  console: { log: console.log, error: (...a) => { errors.push(a.join(' ')); console.error('CONSOLE.ERROR:', ...a); }, warn: console.warn },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval, Promise, Date, Math, JSON, RegExp,
  parseInt, parseFloat, isNaN, String, Number, Object, Array, Error, Set, Map,
  document: docObj,
  location: { search: '' },
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  FileReader: function () {},
  getSelection: () => '',
  addEventListener: windowApi.addEventListener,
  removeEventListener: windowApi.removeEventListener,
  requestAnimationFrame: windowApi.requestAnimationFrame,
  confirm: () => true,
  prompt: () => null
};
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);

for (const f of engineFiles.concat(uiFiles)) {
  try { vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f }); }
  catch (e) { console.error('LOAD ERROR ' + f + ': ' + e.message); process.exit(1); }
}

const NET = sandbox.NET;
let fails = 0, passes = 0;
function ok(cond, title, detail) {
  if (cond) { passes++; }
  else { fails++; console.log('FAIL  ' + title + (detail ? '  [' + detail + ']' : '')); }
}
const $ = id => docObj.getElementById(id);
const text = id => { const e = $(id); return e ? e.textContent : ''; };

(async () => {
  await NET.ui.app.boot();

  ok(!!NET.world, 'мир создан при загрузке');
  ok(text('term-out').indexOf('Linux Network Engineer Trainer') >= 0, 'баннер напечатан в терминале');
  ok(text('term-prompt').indexOf('user@ubuntu') >= 0, 'prompt отрисован', text('term-prompt'));
  const labRows = $('labs-list').childNodes.filter(n => n.className && n.className.indexOf('row') >= 0);
  const groupRows = $('labs-list').childNodes.filter(n => n.className === 'list-group');
  ok(labRows.length === NET.labs.list().length, 'в списке все ' + NET.labs.list().length + ' лабораторий', String(labRows.length));
  ok(groupRows.length === NET.labs.tracks.filter(t => NET.labs.byTrack(t.id).length).length,
    'лаборатории разбиты по разделам курса', String(groupRows.length));
  ok($('modes-grid').childNodes.length === 6, 'в панели 6 режимов');
  ok($('skills-list').childNodes.length === 13, 'в панели 13 навыков');
  ok(text('level-chip').indexOf('Beginner') >= 0, 'уровень Beginner на старте', text('level-chip'));
  ok($('host-select').options.length >= 4, 'селектор хостов заполнен', String($('host-select').options.length));
  ok(text('tab-task').indexOf('С чего начать') >= 0, 'панель задания показывает стартовый экран');
  ok(text('storage-chip').length > 0, 'режим хранилища показан: ' + text('storage-chip'));

  /* выполнение команды через терминал */
  await NET.ui.terminal.run('ip -br a');
  ok(text('term-out').indexOf('192.168.10.20/24') >= 0, 'команда выполнена, вывод в терминале');
  ok(text('term-status-exit') === 'exit 0', 'статус exit-кода обновлён', text('term-status-exit'));
  await NET.ui.terminal.run('nosuchcmd');
  ok(text('term-status-exit') === 'exit 127', 'ошибочная команда даёт exit 127', text('term-status-exit'));

  /* автодополнение */
  const inp = $('term-input');
  inp.value = 'ip ro';
  inp.selectionStart = 5;
  inp.dispatch('keydown', { key: 'Tab', preventDefault() {} });
  ok(inp.value.indexOf('route') >= 0, 'Tab дополняет подкоманду', inp.value);

  /* история стрелками */
  inp.value = '';
  inp.dispatch('keydown', { key: 'ArrowUp', preventDefault() {} });
  ok(inp.value.length > 0, 'ArrowUp подставляет команду из истории', inp.value);
  inp.value = '';

  /* запуск лаборатории кликом по строке */
  $('labs-list').childNodes.filter(n => n.className && n.className.indexOf('row') >= 0)[0].dispatch('click');
  ok(!!NET.labs.current(), 'клик по лаборатории запускает её');
  ok(text('tab-task').indexOf('LAB01') >= 0, 'панель задания показывает лабораторию');
  ok(text('lab-chip').indexOf('LAB01') >= 0, 'чип лаборатории в топбаре');
  ok(text('tab-task').indexOf('Шаги диагностики') >= 0, 'показаны шаги диагностики');
  ok(NET.labs.current().variantIndex === 0, 'первое знакомство даёт базовый сценарий');

  /* проверка решения через кнопку */
  $('btn-check').dispatch('click');
  ok(text('tab-task').indexOf('Проверка решения') >= 0, 'чеклист проверки отрисован');
  ok(text('term-out').indexOf('[✘]') >= 0, 'непройденные проверки видны в терминале');

  /* подсказка */
  $('btn-hint').dispatch('click');
  ok(text('tab-task').indexOf('Подсказка') >= 0 || text('term-out').indexOf('Подсказка 1/3') >= 0,
    'подсказка выдана');

  /* решаем и получаем разбор */
  await NET.ui.terminal.run('sudo ip route add default via 192.168.10.1 dev ens33');
  $('btn-check').dispatch('click');
  ok(NET.labs.current().solved, 'лаборатория решена через терминал');
  ok(text('tab-debrief').indexOf('Почему были именно такие симптомы') >= 0, 'разбор отрисован');
  ok(text('tab-debrief').indexOf('Команды, которые решают задачу') >= 0, 'в разборе есть команды');
  ok($('tab-debrief').classList.contains('active'), 'вкладка разбора активирована автоматически');
  ok(text('level-chip').indexOf('%') >= 0, 'уровень пересчитан после решения');
  ok($('labs-list').childNodes.filter(n => n.className && n.className.indexOf('row') >= 0)[0]
    .textContent.indexOf('✔') >= 0, 'лаборатория отмечена решённой');

  /* история */
  NET.ui.app.switchRightTab('history');
  ok(text('tab-history').indexOf('решено лабораторий: 1') >= 0, 'история показывает результат');

  /* топология */
  NET.ui.app.switchCenterTab('topology');
  const svg = $('topo-wrap').childNodes[0];
  ok(svg && svg.tagName === 'SVG', 'схема топологии отрисована как SVG');
  ok(svg.querySelectorAll('.topo-node').length >= 10, 'на схеме есть узлы',
    String(svg.querySelectorAll('.topo-node').length));
  NET.ui.app.switchCenterTab('terminal');

  /* режимы: Command Trainer */
  NET.ui.labs.selectMode('trainer');
  ok(!!NET.ui.task.quick.task, 'Command Trainer выдал задание');
  ok(text('tab-task').indexOf('Command Trainer') >= 0, 'панель показывает режим тренажёра команд');
  const task = NET.ui.task.quick.task;
  if (task.type === 'command') {
    await NET.ui.terminal.run(task.solution.replace(/^sudo /, 'sudo '));
    const res = NET.ui.task.quick.check();
    ok(res && res.ok, 'эталонная команда принимается тренажёром', task.id + ' ' + task.solution);
  }

  /* Quick Practice */
  NET.ui.labs.selectMode('quick');
  ok(!!NET.ui.task.quick.task && NET.ui.task.quick.task.type === 'state',
    'Quick Practice выдал задание на состояние');

  /* палитра и горячие клавиши */
  NET.ui.palette.open();
  ok(NET.ui.palette.active(), 'палитра открывается');
  NET.ui.palette.filter('lab03');
  ok($('palette-results').childNodes.length >= 1, 'палитра фильтрует по запросу');
  NET.ui.palette.close();
  docObj.dispatch('keydown', { key: '?', target: docObj.body, preventDefault() {} });
  ok(!$('help-overlay').classList.contains('hidden'), 'по ? открывается справка по клавишам');
  docObj.dispatch('keydown', { key: 'Escape', target: docObj.body, preventDefault() {} });
  ok($('help-overlay').classList.contains('hidden'), 'Escape закрывает оверлей');

  /* pager и редактор */
  await NET.ui.terminal.run('man ip');
  ok(!$('pager').classList.contains('hidden'), 'man открывается в pager');
  NET.ui.pager.close();
  await NET.ui.terminal.run('sudo nano /etc/netplan/01-netcfg.yaml');
  ok(!$('editor').classList.contains('hidden'), 'nano открывает редактор');
  $('editor-text').value = 'network:\n  version: 2\n  renderer: networkd\n  ethernets:\n    ens33:\n      addresses: [192.168.10.44/24]\n';
  NET.ui.editor.save();
  const saved = NET.world.get('srv1').vfs.read('/etc/netplan/01-netcfg.yaml', NET.ROOTCTX);
  ok(saved.indexOf('192.168.10.44/24') >= 0, 'редактор сохраняет файл в VFS');
  await NET.ui.terminal.run('sudo netplan apply');
  ok(NET.world.get('srv1').net.ownsIP('192.168.10.44'), 'netplan применяет отредактированный конфиг');

  /* переключение хоста селектором */
  $('host-select').value = 'gw';
  $('host-select').dispatch('change');
  ok(NET.world.current === 'gw', 'селектор переключает хост');
  ok(text('term-prompt').indexOf('@gw') >= 0, 'prompt обновился', text('term-prompt'));

  /* selftest прямо из терминала */
  $('host-select').value = 'srv1';
  $('host-select').dispatch('change');
  await NET.ui.terminal.run('selftest');
  ok(text('term-out').indexOf('РЕЗУЛЬТАТ: все') >= 0, 'selftest проходит из терминала');

  /* команды тренажёра, набранные в терминале, обновляют панели */
  await NET.ui.terminal.run('lab start lab03');
  ok(NET.labs.current() && NET.labs.current().lab.id === 'lab03', 'lab start из терминала запускает лабораторию');
  ok(text('tab-task').indexOf('LAB03') >= 0, 'панель задания обновилась после lab start');
  await NET.ui.terminal.run('hint');
  ok(NET.labs.current().hintsUsed === 1, 'hint из терминала учитывается движком');
  ok(text('tab-task').indexOf('Подсказки') >= 0, 'подсказка видна в панели');
  await NET.ui.terminal.run('check');
  ok((NET.labs.current().lastCheck || []).length > 0, 'check из терминала наполняет чеклист панели');
  await NET.ui.terminal.run('sudo ip route del 10.20.0.0/16 via 192.168.10.254');
  const codeCheck = await NET.ui.terminal.run('check');
  ok(codeCheck === 0 && NET.labs.current().solved, 'lab03 решается и check возвращает 0', 'exit ' + codeCheck);
  await NET.ui.terminal.run('lab start nolab');
  ok(text('term-out').indexOf('нет лаборатории nolab') >= 0, 'неизвестная лаборатория даёт понятную ошибку');

  /* теоретическая часть */
  NET.ui.app.switchCenterTab('lesson');
  ok(text('tab-lesson').indexOf('Теория') >= 0, 'вкладка теории показывает список уроков');
  ok($('tab-lesson').querySelectorAll('.lesson-card').length >= 11,
    'в списке все уроки', String($('tab-lesson').querySelectorAll('.lesson-card').length));
  $('tab-lesson').querySelectorAll('.lesson-card')[0].dispatch('click');
  ok(text('tab-lesson').indexOf('Основные команды Linux') >= 0, 'урок открывается по клику');
  ok(text('tab-lesson').indexOf('Коротко') >= 0, 'в уроке есть блок «Коротко»');
  ok(text('tab-lesson').indexOf('Типичные ошибки') >= 0, 'в уроке есть разбор ошибок');
  NET.progress.markLessonRead('linux-basics');
  ok(NET.progress.isLessonRead('linux-basics'), 'отметка о прочтении сохраняется');

  await NET.ui.terminal.run('lesson list');
  ok(text('term-out').indexOf('linux-basics') >= 0, 'команда lesson list выводит уроки');
  await NET.ui.terminal.run('lesson lab06');
  ok(NET.ui.lesson.current() === 'lab06', 'команда lesson открывает урок во вкладке');
  ok(text('tab-lesson').indexOf('MTU') >= 0, 'открыт нужный урок');
  await NET.ui.terminal.run('lesson нет-такого');
  ok(text('term-out').indexOf('нет урока') >= 0, 'неизвестный урок даёт понятную ошибку');

  /* методическая часть урока */
  NET.ui.lesson.open('lab01');
  const lessonText = text('tab-lesson');
  ['Универсальный алгоритм диагностики', 'Словарь симптомов', 'Команды: что показывают и как читать результат',
    'Разбор похожего случая', 'Гипотезы', 'Практика на стенде', 'Ожидаемо:', 'Вопрос:',
    'Показать решение', 'Чек-лист диагностики', 'Контрольные вопросы', 'Тест по командам'].forEach(t => {
    ok(lessonText.indexOf(t) >= 0, 'в уроке lab01 есть блок «' + t + '»');
  });
  const solution = $('tab-lesson').querySelectorAll('.solution')[0];
  ok(solution && solution.tagName === 'DETAILS' && !solution.open, 'решение в уроке свёрнуто по умолчанию');
  ok($('tab-lesson').querySelectorAll('.qa').every(d => !d.open), 'ответы на контрольные вопросы скрыты');

  /* тест по командам */
  $('tab-lesson').querySelectorAll('.lesson-quiz-call')[0].querySelectorAll('.btn')[0].dispatch('click');
  const quizCards = $('tab-lesson').querySelectorAll('.quiz-q');
  const quizData = NET.quiz.get('lab01');
  ok(quizCards.length === quizData.questions.length, 'тест открывается и показывает все вопросы', String(quizCards.length));
  NET.ui.app.switchCenterTab('terminal');
  NET.ui.app.switchCenterTab('lesson');
  ok($('tab-lesson').querySelectorAll('.quiz-q').length === quizData.questions.length,
    'переключение вкладок не сбрасывает открытый тест');

  const pick = (card, right) => {
    const qi = quizCards.indexOf(card);
    const answer = quizData.questions[qi].answer;
    const btn = card.querySelectorAll('.quiz-opt').find(b => (Number(b.getAttribute('data-orig')) === answer) === right);
    btn.dispatch('click');
  };
  pick(quizCards[0], false);
  ok(text('tab-lesson').indexOf('Неверно') >= 0, 'неверный ответ помечается и объясняется');
  pick(quizCards[0], true);
  ok(quizCards[0].querySelectorAll('.quiz-opt').every(b => b.disabled), 'повторно ответить на вопрос нельзя');
  quizCards.slice(1).forEach(c => pick(c, true));
  const quizResult = $('tab-lesson').querySelectorAll('.quiz-result')[0];
  const expected = Math.round((quizData.questions.length - 1) * 100 / quizData.questions.length);
  ok(quizResult && quizResult.textContent.indexOf(expected + '%') >= 0, 'итог теста считается верно', quizResult && quizResult.textContent);
  ok(NET.progress.quizResult('lab01') && NET.progress.quizResult('lab01').best === expected, 'результат теста сохранён в прогрессе');
  NET.ui.lesson.renderIndex();
  ok(text('tab-lesson').indexOf('тест ' + expected + '%') >= 0, 'результат теста виден в списке уроков');

  await NET.ui.terminal.run('quiz list');
  ok(text('term-out').indexOf('лучший ' + expected + '%') >= 0, 'quiz list показывает результаты');
  await NET.ui.terminal.run('quiz lab05');
  ok($('tab-lesson').querySelectorAll('.quiz-q').length === NET.quiz.get('lab05').questions.length,
    'команда quiz открывает тест во вкладке');
  await NET.ui.terminal.run('quiz нет-такого');
  ok(text('term-out').indexOf('нет теста') >= 0, 'неизвестный тест даёт понятную ошибку');
  NET.ui.app.switchCenterTab('terminal');

  ok(errors.length === 0, 'нет ошибок в console.error', errors.slice(0, 3).join(' | '));

  console.log('\n===== UI smoke: ' + passes + ' PASS, ' + fails + ' FAIL =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('UI TEST CRASH', e); process.exit(1); });
