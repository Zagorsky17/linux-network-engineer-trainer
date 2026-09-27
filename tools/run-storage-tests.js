/*
 * Хранилище: каскад режимов, разделы, валидация схемы, миграция v1→v2,
 * импорт/экспорт, переполнение квоты, повреждённые данные.
 */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[2] || '.';
const ALL = JSON.parse(fs.readFileSync(path.join(__dirname, 'files.json'), 'utf8'));
/* хранилищу нужны ядро + skills (схема прогресса опирается на список навыков) */
const CORE = ALL.filter(f => f.startsWith('core/') || f === 'learn/skills.js');

function load(lsImpl, idbImpl) {
  const sandbox = { console, setTimeout, clearTimeout, Promise, Date, Math, JSON, RegExp, parseInt, parseFloat, isNaN, String, Number, Object, Array, Error };
  sandbox.window = sandbox;
  if (lsImpl) sandbox.localStorage = lsImpl;
  if (idbImpl) sandbox.indexedDB = idbImpl;
  const ctx = vm.createContext(sandbox);
  CORE.forEach(f => vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f }));
  return sandbox.NET;
}

function makeLS(initial) {
  const store = new Map(Object.entries(initial || {}));
  return {
    store,
    setItem: (k, v) => store.set(k, String(v)),
    getItem: k => (store.has(k) ? store.get(k) : null),
    removeItem: k => store.delete(k),
    key: i => Array.from(store.keys())[i],
    get length() { return store.size; }
  };
}

let fails = 0, passes = 0;
const ok = (c, t, d) => { if (c) passes++; else { fails++; console.log('FAIL ' + t + (d ? '  [' + d + ']' : '')); } };

(async () => {
  /* ---------- 1. localStorage: разделы и круговой путь ---------- */
  const ls = makeLS();
  const A = load(ls);
  await A.storage.init();
  ok(A.storage.mode === 'local', 'без IndexedDB используется localStorage', A.storage.mode);

  const progress = A.schema.blank('userProgress');
  progress.totals.labsSolved = 3;
  progress.labs.lab01 = { solved: true, best: 92, attempts: 2, variants: ['lab01/base'], history: [] };
  await A.storage.save('userProgress', progress);
  const back = await A.storage.load('userProgress');
  ok(back.totals.labsSolved === 3 && back.labs.lab01.best === 92, 'раздел userProgress сохраняется и читается');
  ok(back.version === A.storage.schemaVersion, 'версия схемы проставлена', String(back.version));
  ok(Object.keys(back.skills).length === A.skills.list.length, 'все навыки восстановлены');

  /* ---------- 2. валидация повреждённых данных ---------- */
  const broken = {
    version: 1, labs: 'сломано', skills: null, totals: 42, streak: [],
    tasks: { ok: { solved: 'много' } }, history: 'нет'
  };
  await A.storage.set('userProgress', broken);
  const repaired = await A.storage.load('userProgress');
  ok(typeof repaired.labs === 'object' && !Array.isArray(repaired.labs), 'битый labs заменён объектом');
  ok(typeof repaired.totals.labsSolved === 'number', 'битый totals восстановлен структурой');
  ok(repaired.skills && typeof repaired.skills === 'object', 'skills=null восстановлены значениями по умолчанию');
  ok(repaired.tasks.ok.solved === 0, 'нечисловое поле заменено значением по умолчанию', String(repaired.tasks.ok.solved));
  ok(A.storage.repairs().length > 0, 'список исправлений доступен для журнала');

  /* частично сохранённое состояние и мусор */
  for (const garbage of [null, 0, 'строка', [], { version: 'нет' }, { labs: { lab01: null } }]) {
    await A.storage.set('userProgress', garbage);
    const r = await A.storage.load('userProgress');
    ok(r && typeof r.labs === 'object' && typeof r.totals.labsSolved === 'number',
      'мусор в хранилище не ломает загрузку: ' + JSON.stringify(garbage));
  }

  /* обрезка гигантских данных */
  const flood = A.schema.blank('learningHistory');
  for (let i = 0; i < 5000; i++) flood.entries.push({ at: Date.now(), kind: 'lab', id: 'x' + i, title: 'T'.repeat(500), score: 50 });
  await A.storage.save('learningHistory', flood);
  const trimmed = await A.storage.load('learningHistory');
  ok(trimmed.entries.length <= 200, 'журнал обучения обрезается схемой', String(trimmed.entries.length));
  ok(trimmed.entries[0].title.length <= 200, 'слишком длинные строки обрезаются');

  /* ---------- 3. опасные ключи ---------- */
  await A.storage.set('userProgress', JSON.parse('{"version":2,"labs":{"__proto__":{"polluted":true},"lab01":{"solved":true}},"skills":{}}'));
  const clean = await A.storage.load('userProgress');
  ok(({}).polluted === undefined, 'Object.prototype не загрязнён при загрузке');
  ok(!Object.prototype.hasOwnProperty.call(clean.labs, '__proto__'), 'ключ __proto__ отброшен схемой');
  ok(clean.labs.lab01.solved === true, 'остальные данные сохранены');

  /* ---------- 4. миграция v1 -> v2 ---------- */
  /* Данные старой версии уже лежат в хранилище до первого запуска новой сборки */
  const legacyLS = makeLS({
    'lnet:profile': JSON.stringify({
      version: 1, created: 1700000000000,
      labs: { lab02: { solved: true, best: 71, attempts: 1, variants: ['lab02/base'], history: [] } },
      skills: { routing: { solved: 2, attempts: 3, failed: 1, ewma: 0.7, hints: 1, maxDifficulty: 3, difficultySum: 5, weak: {}, lastAt: 1, history: [] } },
      totals: { labsSolved: 1, tasksSolved: 4, commands: 120, seconds: 600, hints: 2 },
      streak: { days: 3, last: '2026-09-20' },
      history: [{ at: 1700000000000, kind: 'lab', id: 'lab02', title: 'Статический IP', score: 71 }]
    }),
    'lnet:srs': JSON.stringify({ version: 1, cards: { 'skill:routing': { id: 'skill:routing', skill: 'routing', title: 'Routing', kind: 'skill', step: 2, due: 1700000000000, lapses: 1, reps: 3, lastAt: 1 } } }),
    'lnet:mode': JSON.stringify('practice'),
    'lnet:shell:history': JSON.stringify(['ip route', 'ping 8.8.8.8'])
  });
  const B = load(legacyLS);
  let migratedEvent = null;
  B.bus.on('storage:migrated', ev => { migratedEvent = ev; });
  await B.storage.init();
  ok(!!migratedEvent && migratedEvent.from === 1, 'миграция выполнена при первом запуске новой версии');

  const mProgress = await B.storage.load('userProgress');
  const mHistory = await B.storage.load('learningHistory');
  const mSrs = await B.storage.load('srsCards');
  const mSettings = await B.storage.load('settings');
  const mTerm = await B.storage.load('terminalState');
  ok(mProgress.labs.lab02.best === 71, 'миграция: лаборатории перенесены');
  ok(mProgress.skills.routing.solved === 2, 'миграция: навыки перенесены');
  ok(mHistory.entries.length === 1, 'миграция: журнал обучения выделен в свой раздел');
  ok(mSrs.cards['skill:routing'].step === 2, 'миграция: карточки повторения перенесены');
  ok(mSettings.mode === 'practice', 'миграция: режим перенесён в настройки');
  ok(mTerm.history.length === 2, 'миграция: история терминала перенесена');
  const leftover = await B.storage.keys();
  ok(leftover.indexOf('profile') < 0 && leftover.indexOf('srs') < 0, 'старые ключи удалены', leftover.join(','));
  ok((await B.storage.get('__schemaVersion')) === B.storage.schemaVersion, 'версия схемы записана');

  /* повторный запуск на уже перенесённых данных ничего не ломает */
  const B2 = load(legacyLS);
  let secondMigration = false;
  B2.bus.on('storage:migrated', () => { secondMigration = true; });
  await B2.storage.init();
  ok(!secondMigration, 'повторный запуск не мигрирует заново');
  ok((await B2.storage.load('userProgress')).labs.lab02.best === 71, 'данные на месте после второго запуска');

  /* ---------- 5. экспорт и импорт ---------- */
  const dump = await B.storage.exportAll();
  ok(dump.data.userProgress && dump.data.srsCards && dump.schema === B.storage.schemaVersion,
    'экспорт содержит все разделы и версию схемы');

  const C = load(makeLS());
  await C.storage.init();
  const res = await C.storage.importAll(dump);
  ok(res.kinds.length >= 5, 'импорт принимает все разделы', res.kinds.join(','));
  ok((await C.storage.load('userProgress')).labs.lab02.best === 71, 'импортированный прогресс доступен');

  /* импорт враждебного файла */
  const hostile = JSON.parse('{"data":{"userProgress":{"__proto__":{"isAdmin":true},"labs":{"x":{"solved":"да"}}},"__proto__":{"y":1},"неизвестно":{"a":1}}}');
  await C.storage.importAll(hostile);
  ok(({}).isAdmin === undefined && ({}).y === undefined, 'импорт не загрязняет Object.prototype');
  const afterHostile = await C.storage.load('userProgress');
  ok(afterHostile.labs.x.solved === false,
    'непонятное значение НЕ засчитывается как выполненное задание (прогресс нельзя подделать мусором)',
    String(afterHostile.labs.x.solved));
  const keysAfter = await C.storage.keys();
  ok(keysAfter.indexOf('неизвестно') < 0, 'неизвестные разделы не сохраняются');

  let rejected = false;
  await C.storage.importAll({ nothing: true }).catch(() => { rejected = true; });
  ok(rejected, 'файл без известных разделов отклоняется с ошибкой');
  rejected = false;
  await C.storage.importAll(null).catch(() => { rejected = true; });
  ok(rejected, 'null отклоняется без исключения наружу');

  /* импорт файла старого формата */
  const D = load(makeLS());
  await D.storage.init();
  await D.storage.importAll({ data: { profile: { version: 1, labs: { lab03: { solved: true, best: 55 } }, history: [] } } });
  ok((await D.storage.load('userProgress')).labs.lab03.best === 55, 'импорт файла старого формата поддержан');

  /* ---------- 6. переполнение квоты ---------- */
  const quotaLS = makeLS();
  let allow = true;
  quotaLS.setItem = (k, v) => {
    if (!allow && k.indexOf('__probe') < 0) {
      const e = new Error('The quota has been exceeded.');
      e.name = 'QuotaExceededError';
      throw e;
    }
    quotaLS.store.set(k, String(v));
  };
  const E = load(quotaLS);
  await E.storage.init();
  let quotaEvent = null;
  E.bus.on('storage:full', ev => { quotaEvent = ev; });
  allow = false;
  const savedOk = await E.storage.save('userProgress', E.schema.blank('userProgress'));
  ok(savedOk === false, 'сохранение при переполнении возвращает false, а не бросает');
  ok(!!quotaEvent, 'событие storage:full отправлено интерфейсу');
  ok(E.errors.log().some(e => e.where === 'storage.quota'), 'переполнение попало в журнал ошибок');
  const stillWorks = await E.storage.load('userProgress');
  ok(!!stillWorks && typeof stillWorks.labs === 'object', 'после отказа записи чтение продолжает работать');

  /* ---------- 7. отказ localStorage и IndexedDB ---------- */
  const F = load({
    setItem() { const e = new Error('SecurityError'); e.name = 'SecurityError'; throw e; },
    getItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
    key() { throw new Error('SecurityError'); },
    get length() { throw new Error('SecurityError'); }
  });
  await F.storage.init();
  ok(F.storage.mode === 'memory', 'при отказе localStorage — режим памяти', F.storage.mode);
  ok(F.storage.persistent() === false, 'режим памяти помечен как непостоянный');
  await F.storage.save('settings', { version: 2, mode: 'exam' });
  ok((await F.storage.load('settings')).mode === 'exam', 'в памяти приложение продолжает работать');
  ok(F.storage.describe().indexOf('память') >= 0, 'описание режима для предупреждения в UI');

  /* IndexedDB, который зависает при открытии (частый случай на file://) */
  const G = load(makeLS(), { open() { return { onupgradeneeded: null, onsuccess: null, onerror: null }; } });
  const t0 = Date.now();
  await G.storage.init();
  ok(G.storage.mode === 'local', 'зависший indexedDB.open уходит в fallback по таймауту', G.storage.mode);
  ok(Date.now() - t0 < 5000, 'таймаут ограничен (' + (Date.now() - t0) + ' ms)');

  /* IndexedDB, который бросает при open */
  const H = load(makeLS(), { open() { throw new Error('SecurityError: file origin'); } });
  await H.storage.init();
  ok(H.storage.mode === 'local', 'исключение indexedDB.open обработано', H.storage.mode);

  console.log('\n===== storage: ' + passes + ' PASS, ' + fails + ' FAIL =====');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
