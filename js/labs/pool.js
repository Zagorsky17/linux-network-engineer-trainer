/*
 * pool.js — банк коротких заданий для Quick Practice и Command Trainer.
 *
 * Задания двух типов:
 *   state   — проверяется результат в модели (любой рабочий способ засчитан);
 *   command — проверяется форма команды (тренировка флагов и синтаксиса).
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var P = NET.packet;
  var pool = NET.registries.tasks;

  function reg(t) { pool.push(t); return t; }

  function cmdTask(id, skill, difficulty, prompt, re, solution, theory) {
    return reg({
      id: id, type: 'command', skill: skill, difficulty: difficulty,
      prompt: prompt, match: re, solution: solution, theory: theory
    });
  }

  function stateTask(spec) {
    spec.type = 'state';
    return reg(spec);
  }

  /* ---------- Command Trainer: флаги и синтаксис ---------- */

  cmdTask('ct-ip-br', 'cli', 1,
    'Одной командой покажите все интерфейсы с их состоянием и адресами в компактном виде.',
    /^ip\s+(-4\s+)?-br(ief)?\s+(a|addr|address)/, 'ip -br a', 'iproute2-basics');

  cmdTask('ct-ip-route', 'routing', 1,
    'Покажите таблицу маршрутизации IPv4.',
    /^ip\s+(-4\s+)?(r|route)(\s+(show|list))?\s*$/, 'ip route', 'routing-basics');

  cmdTask('ct-route-get', 'routing', 2,
    'Спросите у ядра, каким маршрутом и через какой интерфейс пойдёт пакет к 8.8.8.8.',
    /^ip\s+(r|route)\s+get\s+8\.8\.8\.8/, 'ip route get 8.8.8.8', 'longest-prefix-match');

  cmdTask('ct-add-route', 'routing', 2,
    'Добавьте статический маршрут до 192.168.50.0/24 через 10.0.0.1 (команда, не выполняя реально).',
    /ip\s+(r|route)\s+(add|replace)\s+192\.168\.50\.0\/24\s+via\s+10\.0\.0\.1/,
    'sudo ip route add 192.168.50.0/24 via 10.0.0.1', 'routing-basics');

  cmdTask('ct-ss-listen', 'services', 1,
    'Покажите все слушающие TCP- и UDP-сокеты с номерами портов и процессами.',
    /^(sudo\s+)?ss\s+-[a-z]*t[a-z]*u[a-z]*l[a-z]*p[a-z]*n|^(sudo\s+)?ss\s+-tulpn/,
    'sudo ss -tulpn', 'sockets-and-ports');

  cmdTask('ct-ping-mtu', 'tcpip', 3,
    'Проверьте прохождение полноразмерного пакета (1500 байт) до 8.8.8.8 без фрагментации.',
    /ping\b(?=.*-M\s*do)(?=.*-s\s*1472)/, 'ping -c3 -s 1472 -M do 8.8.8.8', 'mtu-pmtud');

  cmdTask('ct-dig-server', 'dns', 2,
    'Спросите имя www.example.com напрямую у сервера 8.8.8.8, минуя /etc/resolv.conf.',
    /^dig\s+@8\.8\.8\.8\s+www\.example\.com/, 'dig @8.8.8.8 www.example.com', 'dns-resolution');

  cmdTask('ct-dig-short', 'dns', 1,
    'Получите только IP-адрес домена example.com, без лишнего вывода.',
    /^dig\b.*example\.com.*\+short|^dig\s+\+short\s+example\.com/, 'dig example.com +short', 'dns-resolution');

  cmdTask('ct-dig-ptr', 'dns', 2,
    'Выполните обратный DNS-запрос для адреса 8.8.8.8.',
    /^dig\s+-x\s+8\.8\.8\.8|^host\s+8\.8\.8\.8|^nslookup\s+8\.8\.8\.8/, 'dig -x 8.8.8.8', 'dns-resolution');

  cmdTask('ct-tcpdump-icmp', 'packet', 2,
    'Снимите дамп ICMP-трафика на интерфейсе ens33 без резолва имён.',
    /^(sudo\s+)?tcpdump\b(?=.*-i\s*ens33)(?=.*\bicmp\b)(?=.*-n)/,
    'sudo tcpdump -i ens33 -n icmp', 'packet-capture');

  cmdTask('ct-tcpdump-syn', 'packet', 3,
    'Покажите только TCP-пакеты с установленным флагом SYN на ens33.',
    /tcpdump\b.*tcp\[tcpflags\]\s*&\s*tcp-syn/,
    'sudo tcpdump -i ens33 -n "tcp[tcpflags] & tcp-syn != 0"', 'tcp-handshake');

  cmdTask('ct-journal-unit', 'services', 1,
    'Покажите последние 50 строк журнала сервиса ssh.',
    /^journalctl\b(?=.*-u\s*ssh)(?=.*-n\s*50)/, 'journalctl -u ssh -n 50', 'systemd-basics');

  cmdTask('ct-systemctl-enable', 'services', 1,
    'Включите автозапуск nginx и сразу запустите его одной командой.',
    /systemctl\s+enable\s+--now\s+nginx|systemctl\s+--now\s+enable\s+nginx/,
    'sudo systemctl enable --now nginx', 'systemd-basics');

  cmdTask('ct-ufw-subnet', 'firewall', 3,
    'Разрешите доступ к TCP/22 только из подсети 192.168.10.0/24 средствами ufw.',
    /ufw\s+allow\s+from\s+192\.168\.10\.0\/24\s+to\s+any\s+port\s+22(\s+proto\s+tcp)?/,
    'sudo ufw allow from 192.168.10.0/24 to any port 22 proto tcp', 'firewall-drop-vs-reject');

  cmdTask('ct-iptables-list', 'firewall', 1,
    'Покажите правила цепочки INPUT с номерами строк, без резолва имён.',
    /iptables\b(?=.*-L)(?=.*-n)(?=.*line-numbers)/,
    'sudo iptables -L INPUT -n --line-numbers', 'firewall-drop-vs-reject');

  cmdTask('ct-grep-inet', 'cli', 1,
    'Из вывода `ip a` оставьте только строки с IPv4-адресами (слово inet целиком).',
    /ip\s+a.*\|\s*grep\b.*(-w\s+inet|"\s*inet\s")/, "ip a | grep -w inet", 'pipes-and-filters');

  cmdTask('ct-awk-field', 'cli', 2,
    'Из вывода `ip -br a` выведите только имена интерфейсов и их адреса (1-е и 3-е поля).',
    /ip\s+-br\s+a.*\|\s*awk\b.*\$1.*\$3/, "ip -br a | awk '{print $1, $3}'", 'pipes-and-filters');

  cmdTask('ct-curl-head', 'services', 1,
    'Получите только HTTP-заголовки ответа от http://app1.corp.local.',
    /^curl\b(?=.*-I)(?=.*app1)/, 'curl -I http://app1.corp.local', 'http-basics');

  cmdTask('ct-nc-check', 'services', 1,
    'Проверьте доступность TCP-порта 443 на 192.168.10.30, не устанавливая полноценную сессию.',
    /^nc\b(?=.*-z)(?=.*192\.168\.10\.30)(?=.*443)/, 'nc -zv 192.168.10.30 443', 'sockets-and-ports');

  cmdTask('ct-chmod-key', 'security', 2,
    'Установите на файл ~/.ssh/authorized_keys права «чтение и запись только владельцу».',
    /^chmod\s+(600|u=rw,go=)\s*.*authorized_keys/, 'chmod 600 ~/.ssh/authorized_keys', 'permissions');

  cmdTask('ct-sysctl-forward', 'routing', 2,
    'Включите маршрутизацию IPv4 в текущем сеансе через sysctl.',
    /sysctl\s+-w\s+net\.ipv4\.ip_forward=1/, 'sudo sysctl -w net.ipv4.ip_forward=1', 'routing-basics');

  cmdTask('ct-ip-neigh', 'networking', 1,
    'Покажите ARP-таблицу (соседей) средствами iproute2.',
    /^ip\s+(n|neigh|neighbour)\b/, 'ip neigh', 'arp-and-gateway');

  cmdTask('ct-tracepath', 'tcpip', 2,
    'Определите MTU пути до 8.8.8.8.',
    /^tracepath\b.*8\.8\.8\.8/, 'tracepath 8.8.8.8', 'mtu-pmtud');

  cmdTask('ct-find-yaml', 'linux', 2,
    'Найдите в /etc все файлы с расширением .yaml.',
    /^find\s+\/etc\b.*-name\s+["']?\*\.yaml/, 'find /etc -name "*.yaml"', 'linux-fs');

  cmdTask('ct-ps-grep', 'linux', 1,
    'Найдите процессы, в имени которых встречается nginx.',
    /(ps\s+aux.*\|\s*grep\s+nginx)|^pgrep\b.*nginx/, 'ps aux | grep nginx', 'processes');

  /* ---------- Quick Practice: задания на состояние ---------- */

  stateTask({
    id: 'st-default-route', skill: 'routing', difficulty: 2,
    prompt: 'На текущем хосте нет маршрута по умолчанию. Добавьте его через 192.168.10.1 (любым способом).',
    setup: function (world) {
      var m = world.get('srv1');
      m.net.routes = m.net.routes.filter(function (r) { return r.prefix !== 0; });
    },
    check: function (world) {
      var def = world.get('srv1').net.defaultRoute(4);
      return { ok: !!def && def.gw === '192.168.10.1', detail: def ? 'via ' + def.gw : 'маршрута нет' };
    },
    hint: 'ip route add default via <gw> dev <iface>',
    solution: 'sudo ip route add default via 192.168.10.1 dev ens33',
    theory: 'routing-basics'
  });

  stateTask({
    id: 'st-iface-up', skill: 'networking', difficulty: 1,
    prompt: 'Интерфейс ens33 выключен. Поднимите его.',
    setup: function (world) { world.get('srv1').net.setLink('ens33', { up: false }); },
    check: function (world) {
      var i = world.get('srv1').net.getIface('ens33');
      return { ok: i.state === 'UP', detail: 'состояние ' + i.state };
    },
    hint: 'ip link set <iface> up',
    solution: 'sudo ip link set ens33 up',
    theory: 'iproute2-basics'
  });

  stateTask({
    id: 'st-add-addr', skill: 'networking', difficulty: 2,
    prompt: 'Добавьте на ens33 дополнительный адрес 192.168.10.77/24.',
    check: function (world) {
      var i = world.get('srv1').net.getIface('ens33');
      var ok = i.addrs.some(function (a) { return a.ip === '192.168.10.77' && a.prefix === 24; });
      return { ok: ok, detail: ok ? null : 'адреса нет' };
    },
    hint: 'ip addr add <cidr> dev <iface>',
    solution: 'sudo ip addr add 192.168.10.77/24 dev ens33',
    theory: 'iproute2-basics'
  });

  stateTask({
    id: 'st-open-443', skill: 'firewall', difficulty: 2,
    prompt: 'Firewall закрывает TCP/443. Откройте порт так, чтобы клиент 192.168.10.30 смог подключиться.',
    setup: function (world) {
      var m = world.get('srv1');
      m.fw.ufw.enabled = true;
      m.fw.ufw.defaults.incoming = 'deny';
      m.fw.ufwAdd({ action: 'allow', direction: 'in', proto: 'tcp', port: 22, from: 'any' });
    },
    check: function (world) {
      var r = P.tcpConnect(world, world.get('app1'), '192.168.10.20', 443, {});
      return { ok: !!r.ok, detail: r.ok ? null : NET.checks.describe(r) };
    },
    hint: 'ufw allow <порт>/tcp',
    solution: 'sudo ufw allow 443/tcp',
    theory: 'firewall-drop-vs-reject'
  });

  stateTask({
    id: 'st-start-nginx', skill: 'services', difficulty: 1,
    prompt: 'Веб-сервер остановлен. Запустите nginx и включите его автозапуск.',
    setup: function (world) {
      var m = world.get('srv1');
      m.services.stop('nginx');
      m.services.disable('nginx');
    },
    check: function (world) {
      var u = world.get('srv1').services.get('nginx');
      return {
        ok: u.state === 'active' && u.enabled,
        detail: u.state !== 'active' ? 'сервис ' + u.state : (u.enabled ? null : 'нет автозапуска')
      };
    },
    hint: 'systemctl enable --now <unit>',
    solution: 'sudo systemctl enable --now nginx',
    theory: 'systemd-basics'
  });

  stateTask({
    id: 'st-fix-dns', skill: 'dns', difficulty: 2,
    prompt: 'Разрешение имён не работает: в /etc/resolv.conf указан несуществующий сервер. ' +
      'Сделайте так, чтобы имя app1.corp.local резолвилось.',
    setup: function (world) { world.get('srv1').setResolvConf(['192.168.10.99'], ['corp.local']); },
    check: function (world) {
      var r = NET.dns.resolve(world, world.get('srv1'), 'app1.corp.local', { type: 'A' });
      return { ok: r.ip === '192.168.10.30', detail: r.ip ? 'получено ' + r.ip : 'статус ' + r.status };
    },
    hint: 'Рабочий DNS в этой сети — 192.168.10.5 (правьте /etc/resolv.conf или netplan).',
    solution: 'echo "nameserver 192.168.10.5" | sudo tee /etc/resolv.conf',
    theory: 'dns-resolution'
  });

  stateTask({
    id: 'st-mtu', skill: 'tcpip', difficulty: 2,
    prompt: 'Установите MTU интерфейса ens33 равным 1400.',
    check: function (world) {
      var i = world.get('srv1').net.getIface('ens33');
      return { ok: i.mtu === 1400, detail: 'сейчас ' + i.mtu };
    },
    hint: 'ip link set <iface> mtu <N>',
    solution: 'sudo ip link set ens33 mtu 1400',
    theory: 'mtu-pmtud'
  });

  stateTask({
    id: 'st-ssh-port', skill: 'security', difficulty: 3,
    prompt: 'SSH слушает нестандартный порт 2222. Верните его на 22 (и примените изменения).',
    setup: function (world) {
      var m = world.get('srv1');
      var conf = m.vfs.read('/etc/ssh/sshd_config', NET.ROOTCTX).replace(/^Port 22$/m, 'Port 2222');
      m.vfs.write('/etc/ssh/sshd_config', conf, NET.ROOTCTX);
      m.services.restart('ssh');
    },
    check: function (world) {
      var s = world.get('srv1').net.listening(22, 'tcp');
      return { ok: !!s, detail: s ? null : 'порт 22 не слушается' };
    },
    hint: 'Правьте /etc/ssh/sshd_config, затем sudo systemctl restart ssh (проверка: sudo sshd -t)',
    solution: 'sudo sed -i "s/^Port 2222/Port 22/" /etc/ssh/sshd_config && sudo systemctl restart ssh',
    theory: 'refused-vs-timeout'
  });

  stateTask({
    id: 'st-forwarding', skill: 'routing', difficulty: 2,
    prompt: 'Включите маршрутизацию IPv4 на текущем хосте (net.ipv4.ip_forward).',
    check: function (world) {
      var v = world.get('srv1').net.sysctl['net.ipv4.ip_forward'];
      return { ok: v === '1', detail: 'сейчас ' + v };
    },
    hint: 'sysctl -w <параметр>=1',
    solution: 'sudo sysctl -w net.ipv4.ip_forward=1',
    theory: 'routing-basics'
  });

  stateTask({
    id: 'st-persist-addr', skill: 'automation', difficulty: 3,
    prompt: 'Сделайте адрес 192.168.10.20/24 и шлюз 192.168.10.1 постоянными: ' +
      'после перезагрузки настройки должны сохраниться.',
    setup: function (world) {
      var m = world.get('srv1');
      m.vfs.write('/etc/netplan/01-netcfg.yaml',
        NET.netcfg.renderYaml({ network: { version: 2, renderer: 'networkd', ethernets: {} } }) + '\n',
        NET.ROOTCTX);
      m.netplanSpec = { network: { version: 2, renderer: 'networkd', ethernets: {} } };
    },
    check: function (world) {
      var snap = world.snapshot();
      var m = world.get('srv1');
      var ok = false, detail = null;
      try {
        m.reboot();
        var i = m.net.getIface('ens33');
        var hasAddr = i.addrs.some(function (a) { return a.ip === '192.168.10.20' && a.prefix === 24; });
        var def = m.net.defaultRoute(4);
        ok = hasAddr && def && def.gw === '192.168.10.1';
        detail = ok ? null : 'после перезагрузки конфигурация не восстановилась';
      } finally { world.restore(snap); }
      return { ok: ok, detail: detail };
    },
    hint: 'Правьте /etc/netplan/01-netcfg.yaml и применяйте через netplan apply',
    solution: 'sudo nano /etc/netplan/01-netcfg.yaml && sudo netplan apply',
    theory: 'netplan-basics'
  });

  /* ---------- API ---------- */

  NET.taskPool = {
    list: function () { return pool.slice(); },
    get: function (id) {
      var found = null;
      pool.forEach(function (t) { if (t.id === id) found = t; });
      return found;
    },
    bySkill: function (skill) {
      return pool.filter(function (t) { return t.skill === skill; });
    },
    pick: function (opts) {
      opts = opts || {};
      var list = pool.filter(function (t) {
        if (opts.type && t.type !== opts.type) return false;
        if (opts.skill && t.skill !== opts.skill) return false;
        if (opts.maxDifficulty && t.difficulty > opts.maxDifficulty) return false;
        if (opts.exclude && opts.exclude.indexOf(t.id) >= 0) return false;
        return true;
      });
      if (!list.length) return null;
      return U.pick(list);
    },
    /* Проверка: для state — состояние мира, для command — форма введённой команды. */
    check: function (task, world, commands) {
      if (task.type === 'command') {
        var hit = (commands || []).some(function (c) { return task.match.test(c.line.trim()); });
        return { ok: hit, detail: hit ? null : 'нужная команда ещё не введена' };
      }
      try { return task.check(world); }
      catch (e) { return { ok: false, detail: 'ошибка проверки: ' + e.message }; }
    }
  };
})(window.NET);
