/* Прохождение всех лабораторий эталонными командами: check должен пройти */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[2];
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

async function sh(line) {
  out = '';
  const code = await NET.shell.run(session, line, {});
  if (verbose) console.log('  $ ' + line + (code ? '   [exit ' + code + ']' : ''));
  return { code, text: out };
}

const NETPLAN = (body) => `printf '${body}' | sudo tee /etc/netplan/01-netcfg.yaml`;

const walks = {
  lab01: async () => {
    await sh('ip -br a'); await sh('ip route'); await sh('ping -c1 192.168.10.1');
    await sh('ping -c1 8.8.8.8'); await sh('dig www.example.com +short');
    await sh('sudo ip route add default via 192.168.10.1 dev ens33');
  },
  lab02: async () => {
    await sh('ip -br a'); await sh('ip route');
    await sh(NETPLAN('network:\\n  version: 2\\n  renderer: networkd\\n  ethernets:\\n    ens33:\\n      addresses: [192.168.10.25/24]\\n      routes:\\n        - to: default\\n          via: 192.168.10.1\\n      nameservers:\\n        addresses: [192.168.10.5]\\n        search: [corp.local]\\n'));
    await sh('sudo netplan apply');
    await sh('ping -c1 8.8.8.8');
  },
  lab03: async () => {
    await sh('ip route'); await sh('ip route get 10.20.5.10'); await sh('ping -c1 10.20.5.10'); await sh('ip neigh');
    await sh('sudo ip route del 10.20.0.0/16 via 192.168.10.254');
  },
  lab04: async () => {
    await sh('ping -c1 8.8.8.8'); await sh('cat /etc/resolv.conf'); await sh('dig app1.corp.local');
    await sh('dig @192.168.10.5 app1.corp.local');
    await sh(NETPLAN('network:\\n  version: 2\\n  renderer: networkd\\n  ethernets:\\n    ens33:\\n      addresses: [192.168.10.20/24]\\n      routes:\\n        - to: default\\n          via: 192.168.10.1\\n      nameservers:\\n        addresses: [192.168.10.5, 8.8.8.8]\\n        search: [corp.local]\\n'));
    await sh('sudo netplan apply');
  },
  lab05: async () => {
    await sh('sudo ss -tulpn'); await sh('curl -I --max-time 3 https://127.0.0.1');
    await sh('connect app1'); await sh('nc -zv 192.168.10.20 443'); await sh('connect srv1');
    await sh('sudo ufw status verbose');
    await sh('sudo ufw allow 443/tcp');
  },
  lab06: async () => {
    await sh('ping -c1 8.8.8.8'); await sh('ping -c1 -s 1472 -M do 8.8.8.8');
    await sh('tracepath 8.8.8.8'); await sh('ip link show ens33'); await sh('curl -s http://www.example.com/big');
    await sh(NETPLAN('network:\\n  version: 2\\n  renderer: networkd\\n  ethernets:\\n    ens33:\\n      addresses: [192.168.10.20/24]\\n      mtu: 1400\\n      routes:\\n        - to: default\\n          via: 192.168.10.1\\n      nameservers:\\n        addresses: [192.168.10.5, 8.8.8.8]\\n        search: [corp.local]\\n'));
    await sh('sudo netplan apply');
  },
  lab07: async () => {
    await sh('ip -br a'); await sh('ip link show ens33'); await sh('sudo dhclient -v ens33');
    await sh('journalctl -u systemd-networkd -n 10');
    await sh('connect gw'); await sh('systemctl status isc-dhcp-server');
    await sh('sudo systemctl start isc-dhcp-server'); await sh('sudo ss -lunp');
    await sh('connect srv1'); await sh('sudo tcpdump -i ens33 -n port 67 -c 3');
    await sh('sudo dhclient -v ens33');
  },
  lab08: async () => {
    await sh('connect app1'); await sh('nc -zv 192.168.10.20 22'); await sh('connect srv1');
    await sh('sudo ss -tlnp'); await sh('systemctl status ssh'); await sh('sudo grep -n "^Port" /etc/ssh/sshd_config');
    await sh("sudo sed -i 's/^Port 2222/Port 22/' /etc/ssh/sshd_config");
    await sh('sudo sshd -t');
    await sh('sudo systemctl restart ssh');
  },
  lab09: async () => {
    await sh('connect app1'); await sh('nc -zv 192.168.10.20 443'); await sh('connect srv1');
    await sh('sudo tcpdump -i ens33 -n port 443 -c 8');
    await sh('ss -tlnp'); await sh('sudo iptables -L INPUT -n --line-numbers');
    await sh('sudo iptables -D INPUT -p tcp --dport 443 -j DROP');
  },
  lab10: async () => {
    await sh('ip -br a'); await sh('ip route'); await sh('ping -c1 8.8.8.8'); await sh('dig www.example.com');
    await sh('systemctl --failed'); await sh('systemctl status nginx'); await sh('sudo ss -tulpn');
    await sh('sudo ufw status verbose'); await sh('connect app1'); await sh('nc -zv 192.168.10.20 443'); await sh('connect srv1');
    await sh(NETPLAN('network:\\n  version: 2\\n  renderer: networkd\\n  ethernets:\\n    ens33:\\n      addresses: [192.168.10.20/24]\\n      routes:\\n        - to: default\\n          via: 192.168.10.1\\n      nameservers:\\n        addresses: [192.168.10.5, 8.8.8.8]\\n        search: [corp.local]\\n'));
    await sh('sudo netplan apply');
    await sh('sudo systemctl enable --now nginx');
    await sh('sudo ufw allow 22/tcp');
    await sh('sudo ufw allow 443/tcp');
  }
};

(async () => {
  let fails = 0;
  for (const id of Object.keys(walks)) {
    const res = NET.labs.start(id, { variant: 0 });
    if (res.err) { console.log('FAIL ' + id + ': ' + res.err); fails++; continue; }
    // вернуть сессию на основной хост
    NET.world.setCurrent('srv1');
    await walks[id]();
    const check = NET.labs.check();
    const st = NET.labs.stepStats();
    if (check.solved) {
      console.log('PASS ' + id + '  шаги диагностики ' + st.done + '/' + st.total +
        '  оценка ' + (check.report ? check.report.score : '?'));
    } else {
      fails++;
      console.log('FAIL ' + id + ' — не решено:');
      check.results.filter(r => !r.ok).forEach(r => console.log('    ✘ ' + r.title + ' — ' + (r.detail || '')));
    }
  }
  console.log('\n===== walkthrough: ' + (Object.keys(walks).length - fails) + '/' + Object.keys(walks).length + ' лабораторий решаются эталонным путём =====');
  process.exit(fails ? 1 : 0);
})();
