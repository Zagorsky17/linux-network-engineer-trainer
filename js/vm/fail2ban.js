/*
 * fail2ban.js — модель fail2ban для защиты от перебора паролей.
 *
 * Как в настоящем fail2ban: служба читает /etc/fail2ban/jail.conf и
 * jail.local (второй переопределяет первый), следит за журналом sshd и
 * после maxretry неудачных попыток с одного адреса вставляет в INPUT
 * правило REJECT (комментарий f2b-sshd). Баны хранятся в состоянии службы
 * (аналог /var/lib/fail2ban/fail2ban.sqlite3) и восстанавливаются при старте,
 * поэтому переживают перезагрузку, если служба включена.
 */
(function (NET) {
  'use strict';

  var ROOT = { uid: 0, gid: 0, groups: [0], user: 'root' };

  var JAIL_CONF = [
    '# /etc/fail2ban/jail.conf — НЕ редактируйте этот файл.',
    '# Переопределения пишите в /etc/fail2ban/jail.local.',
    '',
    '[DEFAULT]',
    'ignoreip = 127.0.0.1/8 ::1',
    'bantime  = 10m',
    'findtime = 10m',
    'maxretry = 5',
    'banaction = iptables-multiport',
    '',
    '[sshd]',
    'port    = ssh',
    'logpath = %(sshd_log)s',
    'backend = systemd',
    '# enabled = true — включается в jail.local',
    ''
  ].join('\n');

  /* строки журнала sshd, которые считаются неудачной попыткой входа */
  var FAIL_RE = /(Failed password|Invalid user|authentication failure|Connection closed by (?:authenticating|invalid) user|maximum authentication attempts)/;
  var IP_RE = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/;

  function parseIni(text, into) {
    var section = null;
    String(text || '').split('\n').forEach(function (raw) {
      var line = raw.replace(/[#;].*$/, '').trim();
      if (!line) return;
      var sm = line.match(/^\[([^\]]+)\]$/);
      if (sm) {
        section = sm[1].trim();
        if (NET.schema.isUnsafeKey(section)) { section = null; return; }
        into[section] = into[section] || {};
        return;
      }
      var eq = line.indexOf('=');
      if (!section || eq <= 0) return;
      var key = line.slice(0, eq).trim().toLowerCase();
      if (NET.schema.isUnsafeKey(key)) return;
      into[section][key] = line.slice(eq + 1).trim();
    });
    return into;
  }

  function readConfig(m) {
    var ini = {};
    ['/etc/fail2ban/jail.conf', '/etc/fail2ban/jail.local'].forEach(function (p) {
      if (!m.vfs.exists(p, ROOT)) return;
      var text = NET.errors.attempt('fail2ban.read', function () { return m.vfs.read(p, ROOT); }, '',
        { silent: true, level: 'warn' });
      parseIni(text, ini);
    });
    var def = ini.DEFAULT || {};
    var sshd = ini.sshd || {};
    function pick(k, d) { return sshd[k] !== undefined ? sshd[k] : (def[k] !== undefined ? def[k] : d); }
    var enabled = /^(true|yes|1)$/i.test(String(pick('enabled', 'false')));
    var maxretry = NET.util.clampInt(pick('maxretry', '5'), 5, 1, 1000);
    var ignore = String(pick('ignoreip', '')).split(/[\s,]+/).filter(Boolean);
    return { sshd: { enabled: enabled, maxretry: maxretry, ignoreip: ignore, bantime: pick('bantime', '10m') } };
  }

  function state(m) {
    if (!m.f2b) m.f2b = { banned: [], fails: {}, totalFailed: 0, totalBanned: 0, conf: null };
    return m.f2b;
  }

  function ignored(conf, ip) {
    return conf.ignoreip.some(function (net) {
      if (net.indexOf(':') >= 0) return false;
      return net.indexOf('/') > 0 ? NET.util.inSubnet(ip, net) : net === ip;
    });
  }

  function applyBan(m, ip) {
    var has = (m.fw.chains.INPUT || []).some(function (r) { return r.comment === 'f2b-sshd' && r.src === ip; });
    if (!has) {
      m.fw.addRule('INPUT', { proto: 'tcp', dport: 22, src: ip, target: 'REJECT', comment: 'f2b-sshd' }, { insert: true });
    }
  }

  function ban(m, ip) {
    var st = state(m);
    if (st.banned.indexOf(ip) >= 0) return;
    st.banned.push(ip);
    st.totalBanned++;
    applyBan(m, ip);
    m.log('fail2ban.actions', 'NOTICE  [sshd] Ban ' + ip, 'notice');
  }

  function unban(m, ip) {
    var st = state(m);
    var i = st.banned.indexOf(ip);
    if (i < 0) return false;
    st.banned.splice(i, 1);
    delete st.fails[ip];
    m.fw.chains.INPUT = m.fw.chains.INPUT.filter(function (r) { return !(r.comment === 'f2b-sshd' && r.src === ip); });
    m.log('fail2ban.actions', 'NOTICE  [sshd] Unban ' + ip, 'notice');
    return true;
  }

  function running(m) {
    return !!(m.services && m.services.isActive('fail2ban'));
  }

  /* Одна строка журнала sshd: засчитать неудачу и при необходимости забанить. */
  function observe(m, msg) {
    var st = state(m);
    if (!running(m) || !st.conf || !st.conf.sshd.enabled) return;
    if (!FAIL_RE.test(msg)) return;
    var ipm = msg.match(IP_RE);
    if (!ipm) return;
    var ip = ipm[1];
    if (ignored(st.conf.sshd, ip) || st.banned.indexOf(ip) >= 0) return;
    st.fails[ip] = (st.fails[ip] || 0) + 1;
    st.totalFailed++;
    m.log('fail2ban.filter', 'INFO    [sshd] Found ' + ip, 'info');
    if (st.fails[ip] >= st.conf.sshd.maxretry) ban(m, ip);
  }

  /* Старт службы: перечитать конфигурацию, вернуть баны, разобрать журнал. */
  function onStart(m) {
    var st = state(m);
    st.conf = readConfig(m);
    m.log('fail2ban.server', 'INFO    Starting Fail2ban v1.0.2');
    if (!st.conf.sshd.enabled) {
      m.log('fail2ban.server', 'INFO    No jails enabled');
      return;
    }
    m.log('fail2ban.jail', 'INFO    Jail \'sshd\' started');
    st.banned.forEach(function (ip) { applyBan(m, ip); });
    st.fails = {};
    m.journal.filter(function (l) { return l.unit === 'sshd'; }).slice(-400).forEach(function (l) {
      observe(m, l.msg);
    });
  }

  function onStop(m) {
    m.fw.chains.INPUT = (m.fw.chains.INPUT || []).filter(function (r) { return r.comment !== 'f2b-sshd'; });
  }

  /* Установить fail2ban на машину: конфигурация и юнит (по умолчанию не запущен). */
  function install(m, opts) {
    opts = opts || {};
    NET.errors.attempt('fail2ban.install', function () {
      if (!m.vfs.exists('/etc/fail2ban', ROOT)) m.vfs.mkdir('/etc/fail2ban', ROOT, { parents: true, mode: 0o755 });
      m.vfs.write('/etc/fail2ban/jail.conf', JAIL_CONF, ROOT, { mode: 0o644 });
      if (opts.jailLocal) m.vfs.write('/etc/fail2ban/jail.local', opts.jailLocal, ROOT, { mode: 0o644 });
    }, null, { silent: true, level: 'warn' });
    if (!m.services.get('fail2ban')) {
      m.services.define({
        name: 'fail2ban', description: 'Fail2Ban Service',
        exec: '/usr/bin/python3 /usr/bin/fail2ban-server -xf start',
        ports: [], state: 'inactive', enabled: !!opts.enabled,
        docs: 'man:fail2ban(1)',
        onStart: function (mm) { onStart(mm); },
        onStop: function (mm) { onStop(mm); }
      });
    }
    state(m);
    if (opts.start) m.services.start('fail2ban');
  }

  /* Журнал sshd → fail2ban той же машины. */
  NET.bus.on('machine:log', function (ev) {
    if (!ev || ev.unit !== 'sshd' || !NET.world || !NET.world.get) return;
    var m = NET.world.get(ev.machine);
    if (m && m.f2b) observe(m, String(ev.msg || ''));
  });

  NET.fail2ban = {
    install: install, readConfig: readConfig, ban: ban, unban: unban,
    state: state, running: running, observe: observe
  };
})(window.NET);
