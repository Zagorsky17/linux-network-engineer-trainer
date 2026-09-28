/* Прогон реальных команд через shell без UI: проверка вывода и exit codes */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.argv[2];
const files = JSON.parse(fs.readFileSync(path.join(__dirname, 'files.json'), 'utf8'));
const sandbox = { console, setTimeout, clearTimeout, Promise, Date, Math, JSON, RegExp, parseInt, parseFloat, isNaN, String, Number, Object, Array, Error };
sandbox.window = sandbox; sandbox.location = { search: '' };
const ctx = vm.createContext(sandbox);
for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
}
const NET = sandbox.NET;
NET.createWorld('campus');

let out = '';
const session = NET.shell.createSession(NET.world, { onOutput: t => { out += t; }, onError: t => { out += t; } });
session.streaming = false;

let fails = 0, passes = 0;
const showAll = process.argv.includes('-v');

async function run(line, asserts) {
  out = '';
  const code = await NET.shell.run(session, line, {});
  const text = out;
  if (showAll) {
    console.log('\n$ ' + line + '   [exit ' + code + ']');
    console.log(text.replace(/\n$/, '').split('\n').slice(0, 24).map(l => '  ' + l).join('\n'));
  }
  (asserts || []).forEach(a => {
    let ok;
    if (a.exit !== undefined) ok = code === a.exit;
    else if (a.has) ok = text.indexOf(a.has) >= 0;
    else if (a.re) ok = a.re.test(text);
    else if (a.not) ok = text.indexOf(a.not) < 0;
    else ok = true;
    if (ok) passes++;
    else {
      fails++;
      console.log('FAIL [' + line + '] ' + JSON.stringify(a) + '\n--- output ---\n' + text.slice(0, 900) + '\n---');
    }
  });
  return { code, text };
}

(async () => {
  await run('pwd', [{ has: '/home/user' }, { exit: 0 }]);
  await run('whoami', [{ has: 'user' }]);
  await run('ls -l /etc/netplan', [{ has: '01-netcfg.yaml' }, { re: /^-rw/m }]);
  await run('cat /etc/os-release', [{ has: 'Ubuntu 24.04' }]);
  await run('cat /etc/shadow', [{ has: 'Permission denied' }, { exit: 1 }]);
  await run('sudo cat /etc/shadow', [{ has: 'root:' }, { exit: 0 }]);
  await run('cat /nope', [{ has: 'No such file or directory' }, { exit: 2 }]);
  await run('foobar', [{ has: 'command not found' }, { exit: 127 }]);

  await run('ip -br a', [{ has: 'ens33' }, { has: '192.168.10.20/24' }, { has: 'UP' }]);
  await run('ip addr show ens33', [{ has: 'inet 192.168.10.20/24' }, { has: 'link/ether' }, { has: 'mtu 1500' }]);
  await run('ip link', [{ has: 'BROADCAST' }, { has: 'lo:' }]);
  await run('ip route', [{ has: 'default via 192.168.10.1 dev ens33' }, { has: 'proto kernel' }]);
  await run('ip route get 8.8.8.8', [{ has: 'via 192.168.10.1' }, { has: 'src 192.168.10.20' }]);
  await run('ip -br link', [{ has: 'ens33' }]);
  await run('ifconfig ens33', [{ has: 'netmask 255.255.255.0' }]);
  await run('route -n', [{ has: 'Kernel IP routing table' }, { has: '0.0.0.0' }]);
  await run('ethtool ens33', [{ has: 'Link detected: yes' }]);

  await run('ping -c 2 192.168.10.1', [{ has: '2 received' }, { has: 'icmp_seq=1' }, { exit: 0 }]);
  await run('ping -c 2 8.8.8.8', [{ has: '2 received' }, { has: 'ttl=' }]);
  await run('ping -c 1 192.168.10.99', [{ has: 'Destination Host Unreachable' }, { exit: 1 }]);
  await run('ping -c 1 nope.invalid', [{ has: 'Name or service not known' }, { exit: 2 }]);
  await run('ping -c 1 -s 2000 -M do 8.8.8.8', [{ has: 'message too long' }]);
  await run('ip neigh', [{ has: '192.168.10.1' }, { has: 'REACHABLE' }]);
  await run('traceroute -n 8.8.8.8', [{ has: '192.168.10.1' }, { has: '8.8.8.8' }]);
  await run('tracepath 8.8.8.8', [{ has: 'pmtu 1500' }, { has: 'Resume' }]);

  await run('ss -tuln', [{ has: 'LISTEN' }, { has: ':443' }]);
  await run('sudo ss -tulpn', [{ has: 'users:(("' }]);
  await run('netstat -tuln', [{ has: 'Active Internet connections' }]);

  await run('dig app1.corp.local +short', [{ has: '192.168.10.30' }]);
  await run('dig @8.8.8.8 www.example.com', [{ has: 'ANSWER SECTION' }, { has: '93.184.216.34' }, { has: 'status: NOERROR' }]);
  await run('dig -x 8.8.8.8 +short', [{ has: 'dns.google' }]);
  await run('host www.example.com', [{ has: 'has address 93.184.216.34' }]);
  await run('nslookup app1.corp.local', [{ has: 'Address: 192.168.10.30' }]);
  await run('resolvectl status', [{ has: 'Link' }]);
  await run('getent hosts www.example.com', [{ has: '93.184.216.34' }]);

  await run('curl -I http://www.example.com', [{ has: 'HTTP/1.1 200 OK' }, { has: 'Server: nginx' }]);
  await run('curl http://app1.corp.local', [{ has: 'Welcome to nginx' }]);
  await run('curl -I http://192.168.10.20:3306', [{ has: 'Failed to connect' }, { exit: 7 }]);
  await run('nc -zv 192.168.10.30 443', [{ has: 'succeeded' }, { exit: 0 }]);
  await run('nc -zv 192.168.10.30 3306', [{ has: 'failed: Connection refused' }, { exit: 1 }]);
  await run('wget -O - http://www.example.com', [{ has: 'Example Domain' }]);

  await run('systemctl status ssh', [{ has: 'active (running)' }, { has: 'Loaded: loaded' }]);
  await run('systemctl is-active nginx', [{ has: 'active' }, { exit: 0 }]);
  await run('systemctl restart nginx', [{ has: 'Access denied' }, { exit: 1 }]);
  await run('sudo systemctl restart nginx', [{ exit: 0 }]);
  await run('journalctl -u nginx -n 5', [{ has: 'nginx' }]);
  await run('sudo systemctl stop nginx', [{ exit: 0 }]);
  await run('ss -ltn', [{ not: ':443' }]);
  await run('sudo systemctl start nginx', [{ exit: 0 }]);
  await run('ps aux', [{ has: 'sshd' }, { has: 'PID' }]);
  await run('top', [{ has: 'load average' }, { has: 'PID USER' }]);
  await run('sudo pkill -9 nginx', [{ exit: 0 }]);
  await run('systemctl status nginx', [{ has: 'failed' }]);
  await run('sudo systemctl start nginx', [{ exit: 0 }]);

  await run('sudo ufw status', [{ has: 'Status: inactive' }]);
  await run('sudo ufw allow 443/tcp', [{ has: 'Rule added' }]);
  await run('sudo ufw enable', [{ has: 'Firewall is active' }]);
  await run('sudo ufw status numbered', [{ has: '443/tcp' }, { has: 'ALLOW' }]);
  await run('sudo iptables -L -n', [{ has: 'Chain INPUT' }, { has: 'DROP' }]);
  await run('sudo ufw disable', [{ has: 'Firewall stopped' }]);
  await run('sudo iptables -A INPUT -p tcp --dport 8080 -j DROP', [{ exit: 0 }]);
  await run('sudo iptables -L INPUT -n --line-numbers', [{ has: '8080' }]);
  await run('sudo nft list ruleset', [{ has: 'table inet filter' }, { has: 'chain input' }]);
  await run('sudo iptables -F', [{ exit: 0 }]);

  await run('ping -c 2 8.8.8.8', []);
  await run('sudo tcpdump -i ens33 -n icmp -c 5', [{ has: 'ICMP echo request' }, { has: 'listening on ens33' }]);
  await run('sudo tcpdump -i ens33 -n "port 443"', [{ re: /packets captured/ }]);
  await run('sudo tcpdump -i ens33 -n "port ("', [{ has: 'syntax error' }, { exit: 1 }]);
  await run('tcpdump -i ens33', [{ has: "don't have permission" }]);

  await run('echo hello > /tmp/t.txt', [{ exit: 0 }]);
  await run('cat /tmp/t.txt', [{ has: 'hello' }]);
  await run('echo world >> /tmp/t.txt && cat /tmp/t.txt', [{ has: 'hello\nworld' }]);
  await run('ip a | grep -w inet | wc -l', [{ re: /[2-9]/ }]);
  await run("ip -br a | awk '{print $1, $3}'", [{ has: 'ens33 192.168.10.20/24' }]);
  await run("ss -ltn | grep -c LISTEN", [{ re: /\d/ }]);
  await run('cat /etc/passwd | cut -d: -f1 | sort | head -3', [{ has: 'daemon' }]);
  await run("echo 'a b c' | awk '{print $2}'", [{ has: 'b' }]);
  await run("echo abc | sed 's/b/X/'", [{ has: 'aXc' }]);
  await run('false || echo fallback', [{ has: 'fallback' }, { exit: 0 }]);
  await run('true && echo yes', [{ has: 'yes' }, { exit: 0 }]);
  await run('false && echo no', [{ not: 'no' }, { exit: 1 }]);
  await run('true || echo no', [{ not: 'no' }, { exit: 0 }]);
  await run('basename /etc/netplan/01-netcfg.yaml .yaml', [{ has: '01-netcfg' }]);
  await run('dirname /etc/netplan/01-netcfg.yaml', [{ has: '/etc/netplan' }]);
  await run('ping -c abc 8.8.8.8', [{ has: "invalid argument: 'abc'" }, { exit: 2 }]);
  await run('ping -c 1000 8.8.8.8', [{ has: 'ограничение тренажёра' }]);
  await run('head -n abc /etc/hostname', [{ has: "invalid argument: 'abc'" }, { exit: 1 }]);
  await run("sed 's/[/X/' /etc/hostname", [{ has: 'sed:' }, { not: 'internal error' }, { exit: 1 }]);
  await run('find /etc -name "["', [{ not: 'internal error' }]);
  await run('export __proto__=1', [{ has: 'not a valid identifier' }, { exit: 1 }]);
  await run('ls /nope 2>/dev/null; echo done', [{ has: 'done' }, { not: 'No such file' }]);
  await run('cat /etc/hostname; echo $?', [{ has: 'ubuntu' }, { has: '0' }]);
  await run('cat /nope; echo code=$?', [{ has: 'code=2' }]);
  await run('export FOO=bar && echo $FOO', [{ has: 'bar' }]);
  await run('echo "user is $USER"', [{ has: 'user is user' }]);
  await run("echo 'no $expand'", [{ has: 'no $expand' }]);
  await run('echo $(hostname)', [{ has: 'ubuntu' }]);
  await run('ls /etc/netplan/*.yaml', [{ has: '01-netcfg.yaml' }]);
  await run('find /etc -name "*.yaml"', [{ has: '/etc/netplan/01-netcfg.yaml' }]);
  await run('grep -rn nameserver /etc/resolv.conf', [{ has: 'nameserver' }]);
  await run('man ip', [{ has: 'iproute2' }]);
  await run('help', [{ has: 'Сеть и диагностика' }]);

  await run('sudo cat /etc/netplan/01-netcfg.yaml', [{ has: 'addresses: [192.168.10.20/24]' }]);
  await run('sudo netplan apply', [{ exit: 0 }]);
  await run('ip -br a', [{ has: '192.168.10.20/24' }]);
  await run('netplan status', [{ has: 'Online state' }]);
  await run('nmcli dev status', [{ has: 'NetworkManager is not running' }]);
  await run('sudo ip addr add 192.168.10.88/24 dev ens33', [{ exit: 0 }]);
  await run('ip -br a', [{ has: '192.168.10.88/24' }]);
  await run('sudo ip addr del 192.168.10.88/24 dev ens33', [{ exit: 0 }]);
  await run('sudo ip link set ens33 mtu 1400 && ip link show ens33', [{ has: 'mtu 1400' }]);
  await run('cat /sys/class/net/ens33/mtu', [{ has: '1400' }]);
  await run('sudo ip link set ens33 mtu 1500', []);
  await run('sudo sysctl -w net.ipv4.ip_forward=1', [{ has: 'net.ipv4.ip_forward = 1' }]);
  await run('cat /proc/sys/net/ipv4/ip_forward', [{ has: '1' }]);

  await run('hosts', [{ has: 'branch-srv' }, { has: 'srv1' }]);
  await run('connect gw', [{ has: 'Переключено' }]);
  await run('ip route', [{ has: '10.20.0.0/16' }]);
  await run('hostname', [{ has: 'gw' }]);
  await run('connect srv1', [{ has: 'Переключено' }]);
  await run('ssh user@app1', [{ has: 'Welcome to Ubuntu' }]);
  await run('hostname', [{ has: 'app1' }]);
  await run('connect srv1', []);

  await run('lab list', [{ has: 'lab01' }, { has: 'lab10' }]);
  await run('lab start lab01', [{ has: 'Запущена лаборатория' }]);
  await run('ip route', [{ not: 'default via' }]);
  await run('ping -c 1 8.8.8.8', [{ has: 'Network is unreachable' }]);
  await run('check', [{ has: '[✘]' }, { exit: 1 }]);
  await run('hint', [{ has: 'Подсказка 1/3' }]);
  await run('sudo ip route add default via 192.168.10.1 dev ens33', [{ exit: 0 }]);
  await run('ping -c 1 8.8.8.8', [{ has: '1 received' }]);
  await run('check', [{ has: 'Задача решена' }, { exit: 0 }]);
  await run('lab start lab05', [{ has: 'Запущена лаборатория' }]);
  await run('connect app1', []);
  await run('nc -zv 192.168.10.20 443', [{ has: 'failed' }]);
  await run('connect srv1', []);
  await run('sudo ufw allow 443/tcp', [{ has: 'Rule added' }]);
  await run('check', [{ has: 'Задача решена' }]);
  await run('reset', [{ has: 'восстановлено' }]);
  await run('check', [{ has: '[✘]' }]);

  await run('apt list', [{ has: 'iproute2' }]);
  await run('sudo apt update', [{ has: 'Reading package lists' }]);
  await run('sudo apt install tcpdump', [{ has: 'Setting up tcpdump' }]);
  await run('dpkg -l', [{ has: 'iproute2' }]);
  await run('id', [{ has: 'uid=1000' }, { has: 'sudo' }]);
  await run('sudo -i', []);
  await run('whoami', [{ has: 'root' }]);
  await run('exit', []);
  await run('whoami', [{ has: 'user' }]);
  await run('crontab -l', [{ has: 'no crontab' }, { exit: 1 }]);
  await run('ssh-keygen -t ed25519 -N ""', [{ has: 'key fingerprint' }]);
  await run('ls -l /home/user/.ssh', [{ has: 'id_ed25519' }]);
  await run('openssl s_client -connect www.example.com:443', [{ has: 'CONNECTED' }]);
  await run('sudo sshd -t', [{ exit: 0 }]);
  await run('sudo nginx -t', [{ has: 'syntax is ok' }]);

  /* --- механики, на которых держатся lab11–lab15 --- */
  NET.labs.stop();
  NET.world.rebuild();
  NET.world.setCurrent('srv1');
  await run('ipcalc 192.168.10.20/28', [{ has: 'Network:   192.168.10.16/28' }, { has: 'HostMax:   192.168.10.30' },
    { has: 'Hosts/Net: 14' }, { exit: 0 }]);
  await run('ipcalc -b 10.0.0.1 255.255.0.0', [{ has: 'Network:   10.0.0.0/16' }, { not: '00001010' }]);
  await run('ipcalc 1.2.3.4/33', [{ has: 'INVALID MASK' }, { exit: 1 }]);
  await run('head -2 /etc/hosts', [{ has: 'localhost' }, { not: 'ip6-allrouters' }]);
  await run('tail -1 /etc/hosts', [{ has: 'ip6-allrouters' }, { not: 'localhost' }]);
  await run('grep hosts /etc/nsswitch.conf', [{ has: 'files dns' }]);
  await run('sudo ip route add 10.50.0.0/16 via 172.16.0.1 dev ens33', [{ has: 'Nexthop has invalid gateway' }, { exit: 2 }]);

  await run("printf 'net.ipv4.ip_forward = 1\\n' | sudo tee /etc/sysctl.d/90-test.conf", []);
  await run('sudo sysctl -p /etc/sysctl.d/90-test.conf', [{ has: 'net.ipv4.ip_forward = 1' }, { exit: 0 }]);
  await run('sudo sysctl -p /etc/nope.conf', [{ has: 'cannot open' }, { exit: 255 }]);
  await run('sysctl -p', [{ has: 'permission denied' }, { exit: 1 }]);
  await run('sudo sysctl --system', [{ has: '* Applying /etc/sysctl.d/90-test.conf' }, { has: 'net.ipv4.ip_forward = 1' }]);
  await run('sudo reboot', [{ exit: 0 }]);
  await run('sysctl net.ipv4.ip_forward', [{ has: '= 1' }]);   // файл применён при загрузке
  await run('sudo rm /etc/sysctl.d/90-test.conf', [{ exit: 0 }]);
  await run('sudo sysctl -w net.ipv4.ip_forward=0', []);

  await run("sudo sed -i 's/listen 443 ssl/listen 127.0.0.1:443 ssl/' /etc/nginx/sites-available/default", [{ exit: 0 }]);
  await run('sudo systemctl reload nginx', [{ exit: 0 }]);
  await run('ss -tln', [{ has: '127.0.0.1:443' }, { has: '0.0.0.0:80' }]);
  await run('connect app1', []);
  await run('nc -zv 192.168.10.20 443', [{ has: 'refused' }]);
  await run('connect srv1', []);
  await run("sudo sed -i 's/listen 127.0.0.1:443 ssl/listen 443 ssl/' /etc/nginx/sites-available/default", []);
  await run('sudo systemctl reload nginx', []);
  await run('ss -tln', [{ has: '0.0.0.0:443' }]);

  await run("sudo sed -i 's/^#ListenAddress 0.0.0.0/ListenAddress 127.0.0.1/' /etc/ssh/sshd_config", []);
  await run('sudo systemctl restart ssh', [{ exit: 0 }]);
  await run('ss -tln', [{ has: '127.0.0.1:22' }]);
  await run("sudo sed -i 's/^ListenAddress 127.0.0.1/#ListenAddress 0.0.0.0/' /etc/ssh/sshd_config", []);
  await run('sudo systemctl restart ssh', []);
  await run('ss -tln', [{ has: '0.0.0.0:22' }]);

  await run('connect gw', []);
  await run('sudo iptables -A FORWARD -s 10.1.0.0/16 -j DROP', [{ exit: 0 }]);
  await run('sudo iptables -A FORWARD -s 10.2.0.0/16 -j DROP', [{ exit: 0 }]);
  await run('sudo iptables -L FORWARD -n --line-numbers', [{ has: 'num  target' }, { re: /\n2 +DROP +all +-- +10\.2\.0\.0\/16/ }]);
  await run('sudo iptables -D FORWARD -s 10.2.0.0/16 -j DROP', [{ exit: 0 }]);
  await run('sudo iptables -L FORWARD -n', [{ has: '10.1.0.0/16' }, { not: '10.2.0.0/16' }]);
  await run('sudo iptables -D FORWARD 1', [{ exit: 0 }]);
  await run('sudo sysctl -w net.ipv4.ip_forward=0', []);
  await run('connect srv1', []);
  await run('ping -c1 8.8.8.8', [{ has: '100% packet loss' }]);           // шлюз без пересылки
  await run('traceroute -n -m 2 8.8.8.8', [{ re: /\n 1 +\* \* \*/ }]);
  await run('connect gw', []);
  await run('sudo sysctl -w net.ipv4.ip_forward=1', []);
  await run('sudo reboot', [{ exit: 0 }]);
  await run('ip -br a', [{ has: '192.168.10.1/24' }, { has: '203.0.113.2/30' }]);   // статические адреса после reboot
  await run('connect srv1', []);
  await run('ping -c1 8.8.8.8', [{ has: '1 received' }]);

  console.log('\n===== shell smoke: ' + passes + ' PASS, ' + fails + ' FAIL =====');
  process.exit(fails ? 1 : 0);
})();
