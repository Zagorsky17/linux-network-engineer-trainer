/* Проверка, что каждый вариант (мутация) лаборатории решаем предполагаемым способом */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[2];
const files = JSON.parse(fs.readFileSync(path.join(__dirname, 'files.json'), 'utf8'));
const sandbox = { console, setTimeout, clearTimeout, Promise, Date, Math, JSON, RegExp, parseInt, parseFloat, isNaN, String, Number, Object, Array, Error };
sandbox.window = sandbox; sandbox.location = { search: '' };
const ctx = vm.createContext(sandbox);
for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
const NET = sandbox.NET;
NET.createWorld('campus');
const ROOTCTX = NET.ROOTCTX;

function netplan(host, doc) {
  const m = NET.world.get(host);
  m.vfs.write('/etc/netplan/01-netcfg.yaml', NET.netcfg.renderYaml(doc) + '\n', ROOTCTX);
  NET.netcfg.apply(NET.world, m, NET.netcfg.loadFiles(m).doc);
}
const eth = (extra) => ({
  network: { version: 2, renderer: 'networkd', ethernets: { ens33: Object.assign({
    addresses: ['192.168.10.20/24'],
    routes: [{ to: 'default', via: '192.168.10.1' }],
    nameservers: { addresses: ['192.168.10.5', '8.8.8.8'], search: ['corp.local'] }
  }, extra || {}) } }
});

/* Предполагаемое исправление каждого варианта, выраженное через модель */
const fixes = {
  'lab01/m1': w => w.get('srv1').net.setLink('ens33', { up: true }),
  'lab01/m2': w => netplan('srv1', eth()),
  'lab01/m3': w => w.get('gw').net.setLink('ens34', { up: true }),
  'lab02/m1': w => {
    const m = w.get('srv1');
    const conn = { name: 'lan', device: 'ens33', method: 'manual', addresses: ['192.168.10.25/24'],
      gateway: '192.168.10.1', dns: ['192.168.10.5'], 'dns-search': ['corp.local'], autoconnect: true };
    m.nm.connections.push(conn);
    NET.netcfg.nmApply(w, m, conn);
  },
  'lab03/m1': w => w.get('gw').net.addRoute({ dst: '10.20.0.0', prefix: 16, gw: '10.99.0.2', dev: 'ens35', proto: 'static', metric: 100 }),
  'lab04/m1': w => w.get('dns1').services.start('named'),
  'lab04/m2': w => w.get('srv1').services.start('systemd-resolved'),
  'lab05/m1': w => w.get('srv1').fw.delRule('INPUT', { dport: 443, target: 'REJECT' }),
  'lab05/m2': w => w.get('srv1').fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 443, from: '192.168.10.0/24' }),
  'lab06/m1': w => netplan('srv1', eth({ mtu: 1400 })),
  'lab07/m1': w => netplan('srv1', { network: { version: 2, renderer: 'networkd', ethernets: { ens34: { dhcp4: true } } } }),
  'lab07/m2': w => {
    w.get('gw').fw.delRule('INPUT', { proto: 'udp', dport: 67, target: 'DROP' });
    const m = w.get('srv1');
    const lease = NET.dhcp.request(w, m, 'ens33');
    if (lease.ok) NET.dhcp.apply(w, m, 'ens33', lease.lease);
  },
  'lab08/m1': w => {
    const m = w.get('srv1');
    const conf = m.vfs.read('/etc/ssh/sshd_config', ROOTCTX).replace(/^Port$/m, 'Port 22');
    m.vfs.write('/etc/ssh/sshd_config', conf, ROOTCTX);
    m.services.start('ssh');
  },
  'lab08/m2': w => w.get('srv1').fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 22, from: '192.168.10.0/24' }),
  'lab09/m1': w => w.get('app1').net.delAddr('ens33', '192.168.10.20/24'),
  'lab10/m1': w => {
    netplan('srv1', eth());
    w.get('srv1').services.start('ssh');
    w.get('srv1').services.enable('ssh');
    w.get('gw').net.addRoute({ dst: '10.20.0.0', prefix: 16, gw: '10.99.0.2', dev: 'ens35', proto: 'static', metric: 100 });
  }
};

/* Некоторые проверки требуют, чтобы пользователь применил диагностику. */
const diagCommands = {
  'lab09/m1': [{ line: 'sudo arping -I ens33 192.168.10.20' }],
};

/* Мутации новых лабораторий несут решение в себе: solution — команды оболочки. */
let out = '';
const session = NET.shell.createSession(NET.world, { onOutput: t => out += t, onError: t => out += t });
session.streaming = false;
async function runSolution(lines) {
  NET.world.setCurrent('srv1');
  for (const line of lines) {
    out = '';
    await NET.shell.run(session, line, {});
  }
}

(async () => {
  let fails = 0, total = 0;
  for (const lab of NET.labs.list()) {
    const variants = NET.labs.variants(lab);
    for (let idx = 1; idx < variants.length; idx++) {   // базовые варианты покрыты walkthrough
      const v = variants[idx];
      total++;
      const key = lab.id + '/m' + idx;
      NET.labs.start(lab.id, { variant: idx });
      const before = NET.labs.check();
      const fix = fixes[key];
      const lines = Array.isArray(v.solution) && v.solution.length ? v.solution : null;
      if (!fix && !lines) { console.log('FAIL ' + key + ' (' + v.name + ') — нет решения (поле solution у мутации)'); fails++; continue; }
      try {
        if (fix) fix(NET.world); else await runSolution(lines);
      } catch (e) { console.log('FAIL ' + key + ' — исправление упало: ' + e.message); fails++; continue; }
      (diagCommands[key] || []).forEach(c => NET.labs.current().commands.push({ line: c.line, ts: Date.now() }));
      const after = NET.labs.check();
      if (!before.solved && after.solved) {
        console.log('PASS ' + key + '  (' + v.name + ')');
      } else {
        fails++;
        console.log('FAIL ' + key + ' (' + v.name + ') — before.solved=' + before.solved + ' after.solved=' + after.solved);
        after.results.filter(r => !r.ok).forEach(r => console.log('    ✘ ' + r.title + ' — ' + (r.detail || '')));
      }
    }
  }
  console.log('\n===== mutations: ' + (total - fails) + '/' + total + ' вариантов решаются =====');
  process.exit(fails ? 1 : 0);
})();
