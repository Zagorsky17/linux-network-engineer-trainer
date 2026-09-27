/* Node-харнесс: загружает движок без UI и прогоняет selftest */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.argv[2];
const files = JSON.parse(fs.readFileSync(path.join(__dirname, 'files.json'), 'utf8'));

const sandbox = { console, setTimeout, clearTimeout, Promise, Date, Math, JSON, RegExp, parseInt, parseFloat, isNaN, String, Number, Object, Array, Error };
sandbox.window = sandbox;
sandbox.location = { search: '' };
const ctx = vm.createContext(sandbox);

for (const f of files) {
  const code = fs.readFileSync(path.join(ROOT, 'js', f), 'utf8');
  try {
    vm.runInContext(code, ctx, { filename: f });
  } catch (e) {
    console.error('LOAD ERROR in ' + f + ': ' + e.message);
    process.exit(1);
  }
}

const NET = sandbox.NET;
NET.createWorld('campus');
const res = NET.selftest.run({ verbose: process.argv.includes('-v') });
console.log(res.lines.join('\n'));
process.exit(res.failed ? 1 : 0);
