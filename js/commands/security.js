/*
 * security.js — secaudit: самопроверка защищённости сервера.
 *
 * Учебный инструмент, которого нет в настоящей Ubuntu: он собирает в одном
 * месте те проверки, которые инженер иначе делает десятком команд (ss, ufw,
 * sshd -T, find -perm, awk по /etc/passwd), и для каждой находки показывает,
 * чем её закрыть. Смотрит только на состояние своей машины: ничего не сканирует
 * и никуда не обращается.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;
  var ROOT = NET.ROOTCTX;

  /* Штатные SUID-файлы образа Ubuntu: всё остальное требует объяснения. */
  var STD_SUID = ['/usr/bin/sudo', '/usr/bin/passwd', '/usr/bin/su', '/usr/bin/mount', '/usr/bin/umount',
    '/usr/bin/chsh', '/usr/bin/newgrp', '/usr/bin/gpasswd', '/usr/lib/openssh/ssh-keysign'];
  /* Порты, которые публичный сервер обычно и должен отдавать наружу. */
  var PUBLIC_PORTS = [22, 80, 443];
  var SEV = { high: 'ВЫСОКИЙ', medium: 'СРЕДНИЙ', low: 'НИЗКИЙ' };
  var ORDER = { high: 0, medium: 1, low: 2 };

  function audit(m) {
    var out = [];
    function add(sev, area, text, fix) { out.push({ sev: sev, area: area, text: text, fix: fix }); }

    /* ---- вход по SSH ---- */
    var ssh = m.sshdConfig();
    if (ssh.permitrootlogin === 'yes') {
      add('high', 'SSH', 'разрешён вход root по паролю (PermitRootLogin yes)',
        'PermitRootLogin no в /etc/ssh/sshd_config, затем sshd -t и systemctl restart ssh');
    }
    if (ssh.passwordauthentication !== 'no') {
      add('medium', 'SSH', 'принимается парольная аутентификация — возможен подбор',
        'PasswordAuthentication no после проверки, что вход по ключу работает');
    }
    var fileSsh = m.sshdFileConfig();
    ['permitrootlogin', 'passwordauthentication', 'port'].forEach(function (k) {
      if (String(fileSsh[k]) !== String(ssh[k])) {
        add('medium', 'SSH', 'sshd_config изменён, но служба не перезапущена: действуют старые параметры (' + k + ')',
          'sudo sshd -t && sudo systemctl restart ssh');
      }
    });

    /* ---- автоматическая блокировка источников ---- */
    var f2b = m.services.get('fail2ban');
    if (f2b) {
      var conf = NET.fail2ban.readConfig(m);
      if (f2b.state !== 'active') {
        add('medium', 'fail2ban', 'служба установлена, но не запущена — блокировки не работают',
          'sudo systemctl enable --now fail2ban');
      } else if (!conf.sshd.enabled) {
        add('medium', 'fail2ban', 'служба запущена, но jail sshd не включён',
          'enabled = true в /etc/fail2ban/jail.local, затем systemctl restart fail2ban');
      } else if (!f2b.enabled) {
        add('medium', 'fail2ban', 'служба работает, но не в автозапуске — не переживёт перезагрузку',
          'sudo systemctl enable fail2ban');
      }
      if (conf.sshd.enabled && conf.sshd.maxretry > 10) {
        add('low', 'fail2ban', 'maxretry = ' + conf.sshd.maxretry + ': бан наступит слишком поздно',
          'maxretry 3–5 в /etc/fail2ban/jail.local');
      }
      conf.sshd.ignoreip.forEach(function (net) {
        if (net.indexOf('127.') === 0 || net === '::1') return;
        add('medium', 'fail2ban', 'в ignoreip внесена сеть ' + net + ' — она никогда не блокируется',
          'оставьте в ignoreip только свои адреса');
      });
    }

    /* ---- межсетевой экран ---- */
    var hasRules = (m.fw.chains.INPUT || []).length > 0;
    if (!m.fw.ufw.enabled && !hasRules && m.fw.policy.INPUT === 'ACCEPT') {
      add('high', 'Firewall', 'входящий трафик не фильтруется',
        'ufw default deny incoming, разрешить нужные порты, затем ufw enable');
    } else if (m.fw.ufw.enabled && m.fw.ufw.defaults.incoming === 'allow') {
      add('high', 'Firewall', 'ufw включён, но политика входящих — allow',
        'sudo ufw default deny incoming');
    }
    if (m.fw.ufw.enabled && !m.services.isEnabled('ufw')) {
      add('medium', 'Firewall', 'ufw включён, но его юнит не в автозапуске — после перезагрузки правил не будет',
        'sudo systemctl enable ufw');
    }
    m.fw.ufw.rules.forEach(function (r) {
      if (r.action !== 'allow' || r.direction !== 'in' || r.from !== 'any') return;
      if (r.port === null || PUBLIC_PORTS.indexOf(Number(r.port)) >= 0) return;
      add('medium', 'Firewall', 'порт ' + r.port + ' открыт с любого адреса (Anywhere)',
        'ограничьте источник: ufw allow from <сеть> to any port ' + r.port + ', либо удалите правило');
    });

    /* ---- параметры ядра ---- */
    if (m.net.sysctl['net.ipv4.tcp_syncookies'] !== '1') {
      add('medium', 'Kernel', 'SYN cookies выключены — сервер уязвим к SYN-флуду',
        'net.ipv4.tcp_syncookies = 1 в /etc/sysctl.d/*.conf, затем sysctl --system');
    }

    /* ---- поверхность атаки ---- */
    m.net.sockets.forEach(function (s) {
      if (s.state !== 'LISTEN' || s.proto !== 'tcp') return;
      if (s.addr !== '0.0.0.0' && s.addr !== '*') return;
      if (PUBLIC_PORTS.indexOf(Number(s.port)) >= 0) return;
      var filtered = !m.fw.allowsInput('tcp', s.port, '198.51.100.10');
      add(filtered ? 'low' : 'high', 'Services',
        'порт ' + s.port + '/tcp (' + (s.process || '?') + ') слушает все адреса' +
        (filtered ? ', но закрыт фильтром' : ' и доступен снаружи'),
        'привяжите службу к 127.0.0.1 или отключите её; лишнее — systemctl disable --now');
    });

    /* ---- учётные записи ---- */
    m.users.users.forEach(function (u) {
      if (u.uid === 0 && u.name !== 'root') {
        add('high', 'Accounts', 'учётная запись ' + u.name + ' имеет uid 0 — это второй суперпользователь',
          'проверьте её происхождение; если посторонняя — sudo userdel ' + u.name);
      }
    });

    /* ---- закрепление: SUID, cron, ключи ---- */
    m.vfs.walkTree('/', ROOT, function (path, node) {
      if (node.type !== 'file' || !(node.mode & 0o4000)) return;
      if (STD_SUID.indexOf(path) >= 0) return;
      add('high', 'Persistence', 'посторонний SUID-файл ' + path + ' — выполняется с правами владельца',
        'проверьте происхождение файла и удалите, если он не от пакета');
    });
    ['/etc/cron.d', '/var/spool/cron/crontabs'].forEach(function (dir) {
      if (!m.vfs.exists(dir, ROOT)) return;
      m.vfs.list(dir, ROOT).forEach(function (e) {
        if (e.node.type !== 'file') return;
        var text = NET.errors.attempt('secaudit.cron', function () { return m.vfs.read(e.path, ROOT); }, '',
          { silent: true, level: 'warn' });
        if (/\/usr\/local\/|\/tmp\/|@reboot/.test(String(text))) {
          add('medium', 'Persistence', 'задание ' + e.path + ' запускает команду вне системных каталогов',
            'проверьте содержимое: sudo cat ' + e.path);
        }
      });
    });

    /* ---- права веб-корня ---- */
    if (m.vfs.exists('/var/www/html', ROOT)) {
      m.vfs.walkTree('/var/www/html', ROOT, function (path, node) {
        if ((node.mode & 0o002) === 0) return;
        add('medium', 'WebRoot', path + ' доступен на запись всем пользователям',
          'chown root:www-data и chmod 755 (каталоги) / 644 (файлы)');
      });
      ['/var/www/html/.git', '/var/www/html/.env'].forEach(function (p) {
        if (m.vfs.exists(p, ROOT)) {
          add('medium', 'WebRoot', 'служебный путь ' + p + ' находится в веб-корне',
            'уберите из веб-корня и закройте: location ~ /\\. { deny all; }');
        }
      });
    }

    out.sort(function (a, b) { return ORDER[a.sev] - ORDER[b.sev]; });
    return out;
  }

  reg({
    name: 'secaudit', category: 'security', summary: 'самопроверка защищённости сервера',
    usage: 'secaudit [-q] [--fix]',
    complete: function () { return ['-q', '--fix']; },
    run: function (ctx) {
      if (!ctx.isRoot) {
        return ctx.fail('secaudit: требуется root (часть проверок читает /etc/shadow и правила firewall)', 1);
      }
      var p = A.parse(ctx.argv, { bool: ['q', 'fix'] });
      var found = audit(ctx.machine);
      var counts = { high: 0, medium: 0, low: 0 };
      found.forEach(function (f) { counts[f.sev]++; });

      if (!found.length) {
        ctx.line('secaudit: замечаний нет.');
        ctx.line('Проверены: вход по SSH, автоблокировка, firewall, параметры ядра,');
        ctx.line('слушающие порты, учётные записи, точки закрепления, права веб-корня.');
        ctx.line('Отдельно проверьте вручную: ключи в authorized_keys и задания cron.');
        return 0;
      }

      ctx.line('Отчёт secaudit для ' + ctx.machine.hostname + ': замечаний ' + found.length +
        ' (высоких ' + counts.high + ', средних ' + counts.medium + ', низких ' + counts.low + ')');
      ctx.line('');
      found.forEach(function (f, i) {
        ctx.line(U.pad(i + 1, 2) + '. [' + SEV[f.sev] + '] ' + f.area + ': ' + f.text);
        if (!p.flags.q) ctx.line('    как закрыть: ' + f.fix);
      });
      ctx.line('');
      ctx.line('secaudit ничего не меняет сам: решения принимает инженер.');
      ctx.line('Он не проверяет содержимое ключей в authorized_keys, смысл заданий cron');
      ctx.line('и происхождение файлов — это остаётся за ручным разбором.');
      return counts.high ? 2 : 1;
    }
  });

  NET.secaudit = { run: audit };
})(window.NET);
