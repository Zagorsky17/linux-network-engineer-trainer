/*
 * Практика из уроков против настоящего стенда.
 *
 * Для каждой лабораторной с методической частью (js/learn/method.js):
 *   1) шаги практики выполняются по порядку на базовом варианте, и вывод
 *      сверяется с sees/absent — «ожидаемый результат» в тексте урока
 *      обязан совпадать с тем, что увидит студент;
 *   2) выполняется скрытое решение, затем его проверки (verify);
 *   3) проверка лабораторной (check) должна пройти — решение в уроке рабочее.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[2] || '.';
const files = JSON.parse(fs.readFileSync(path.join(__dirname, 'files.json'), 'utf8'));
const sandbox = { console, setTimeout, clearTimeout, Promise, Date, Math, JSON, RegExp, parseInt, parseFloat, isNaN, String, Number, Object, Array, Error };
sandbox.window = sandbox; sandbox.location = { search: '' };
const ctx = vm.createContext(sandbox);
for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
const NET = sandbox.NET;
NET.createWorld('campus');

let out = '';
const session = NET.shell.createSession(NET.world, { onOutput: t => out += t, onError: t => out += t });
session.streaming = false;
const verbose = process.argv.includes('-v');

let passes = 0, fails = 0;
function ok(cond, msg, detail) {
  if (cond) { passes++; if (verbose) console.log('  ok   ' + msg); }
  else { fails++; console.log('  FAIL ' + msg + (detail ? '\n       ' + detail.replace(/\n/g, '\n       ') : '')); }
}

async function sh(line) {
  out = '';
  const code = await NET.shell.run(session, line, {});
  return { code, text: out };
}

function expectOutput(tag, step, text) {
  if (step.sees !== undefined) {
    ok(text.indexOf(step.sees) >= 0, tag + ': в выводе есть «' + step.sees.trim() + '»', text.slice(0, 600));
  }
  if (step.absent !== undefined) {
    ok(text.indexOf(step.absent) < 0, tag + ': в выводе нет «' + step.absent + '»', text.slice(0, 600));
  }
}

(async () => {
  const ids = NET.method.ids();
  for (const id of ids) {
    const lesson = NET.lessons.get(id);
    const m = NET.method.get(id);
    if (!lesson || !lesson.lab) { ok(false, id + ': методическая часть без лабораторной'); continue; }
    console.log('== ' + id);

    const res = NET.labs.start(lesson.lab, { variant: 0 });
    if (res && res.err) { ok(false, id + ': лабораторная не запускается', res.err); continue; }
    NET.world.setCurrent('srv1');

    for (let i = 0; i < m.practice.length; i++) {
      const st = m.practice[i];
      const r = await sh(st.cmd);
      expectOutput(id + ' практика ' + (i + 1) + ' [' + st.cmd + ']', st, r.text);
    }

    ok(NET.labs.check().solved === false, id + ': после диагностики задача ещё не решена (практика ничего не чинит)');

    for (const st of m.solution.steps) {
      if (/\b(nano|vi|vim)\b/.test(st.cmd)) {
        ok(!!st.run, id + ': шаг с редактором «' + st.cmd + '» имеет команду для автопрогона');
      }
      await sh(st.run || st.cmd);
    }
    for (let i = 0; i < m.solution.verify.length; i++) {
      const st = m.solution.verify[i];
      const r = await sh(st.cmd);
      expectOutput(id + ' проверка ' + (i + 1) + ' [' + st.cmd + ']', st, r.text);
    }

    const check = NET.labs.check();
    ok(check.solved, id + ': решение из урока проходит проверку лабораторной',
      check.results.filter(r => !r.ok).map(r => '✘ ' + r.title + ' — ' + (r.detail || '')).join('\n'));
  }

  console.log('\n===== lesson practice: ' + passes + ' PASS, ' + fails + ' FAIL =====');
  process.exit(fails ? 1 : 0);
})();
