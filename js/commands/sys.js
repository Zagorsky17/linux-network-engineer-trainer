/*
 * sys.js — пользователи, права, процессы, системная информация.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;

  /* ---------- идентичность ---------- */

  reg({
    name: 'whoami', category: 'sys', summary: 'текущий пользователь', usage: 'whoami',
    run: function (ctx) { ctx.line(ctx.user); return 0; }
  });

  reg({
    name: 'id', category: 'sys', summary: 'uid/gid и группы', usage: 'id [USER]',
    run: function (ctx) {
      var name = ctx.argv[0] || ctx.user;
      var u = ctx.machine.users.byName(name);
      if (!u) return ctx.fail('id: ‘' + name + '’: no such user');
      var db = ctx.machine.users;
      var groups = db.groupsOf(name).map(function (gid) {
        var g = db.groupByGid(gid);
        return gid + '(' + (g ? g.name : gid) + ')';
      });
      var pg = db.groupByGid(u.gid);
      ctx.line('uid=' + u.uid + '(' + u.name + ') gid=' + u.gid + '(' + (pg ? pg.name : u.gid) + ') groups=' + groups.join(','));
      return 0;
    }
  });

  reg({
    name: 'groups', category: 'sys', summary: 'группы пользователя', usage: 'groups [USER]',
    run: function (ctx) {
      var name = ctx.argv[0] || ctx.user;
      if (!ctx.machine.users.byName(name)) return ctx.fail('groups: ‘' + name + '’: no such user');
      ctx.line(ctx.machine.users.groupNamesOf(name).join(' '));
      return 0;
    }
  });

  reg({
    name: 'sudo', category: 'sys', summary: 'выполнить от имени root', usage: 'sudo COMMAND',
    complete: function (ctx, word) {
      return NET.commands.names().filter(function (n) { return n.indexOf(word) === 0; });
    },
    run: function (ctx) {
      var argv = ctx.argv.slice();
      while (argv.length && argv[0][0] === '-') {
        if (argv[0] === '-i' || argv[0] === '-s') {
          argv.shift();
          if (!argv.length) {
            ctx.session.setUser('root');
            ctx.machine.log('sudo', ctx.user + ' : TTY=pts/0 ; PWD=' + ctx.cwd + ' ; USER=root ; COMMAND=/bin/bash');
            return 0;
          }
          continue;
        }
        if (argv[0] === '-u') { argv.shift(); argv.shift(); continue; }
        argv.shift();
      }
      if (!argv.length) return ctx.usageError('usage: sudo command');
      if (!ctx.machine.users.canSudo(ctx.user)) {
        ctx.machine.log('sudo', ctx.user + ' : user NOT in sudoers ; COMMAND=' + argv.join(' '), 'err');
        return ctx.fail(ctx.user + ' is not in the sudoers file.  This incident will be reported.');
      }
      ctx.machine.log('sudo', ctx.user + ' : TTY=pts/0 ; PWD=' + ctx.cwd + ' ; USER=root ; COMMAND=' + argv.join(' '));
      return NET.shell.invokeAs(ctx, argv, 'root');
    }
  });

  reg({
    name: 'su', category: 'sys', summary: 'сменить пользователя', usage: 'su [-] [USER]',
    run: function (ctx) {
      var argv = ctx.argv.filter(function (a) { return a !== '-' && a !== '-l'; });
      var target = argv[0] || 'root';
      if (!ctx.machine.users.byName(target)) return ctx.fail('su: user ' + target + ' does not exist');
      if (!ctx.isRoot && !ctx.machine.users.canSudo(ctx.user)) {
        ctx.machine.log('su', 'FAILED SU (to ' + target + ') ' + ctx.user + ' on pts/0', 'err');
        return ctx.fail('su: Authentication failure');
      }
      ctx.session.setUser(target);
      var st = ctx.session.state(ctx.machine);
      if (ctx.rawArgv.indexOf('-') >= 0 || ctx.rawArgv.indexOf('-l') >= 0) {
        st.cwd = st.env.HOME;
        ctx.env.PWD = st.cwd;
      }
      ctx.machine.log('su', '(to ' + target + ') ' + ctx.user + ' on pts/0');
      return 0;
    }
  });

  reg({
    name: 'exit', aliases: ['logout'], category: 'sys', summary: 'выйти из root-сессии', usage: 'exit',
    run: function (ctx) {
      if (ctx.session.state(ctx.machine).user !== ctx.machine.mainUser) {
        ctx.session.setUser(ctx.machine.mainUser);
        return 0;
      }
      ctx.line('logout');
      return 0;
    }
  });

  /* ---------- права ---------- */

  reg({
    name: 'chmod', category: 'sys', summary: 'изменить права', usage: 'chmod [-R] MODE FILE...',
    complete: function (ctx, word, argv, h) { return h.path(ctx, word); },
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['R', 'v', 'c'] });
      if (p.rest.length < 2) return ctx.usageError('chmod: missing operand');
      var modeArg = p.rest.shift();
      var code = 0;
      p.rest.forEach(function (f) {
        var abs = ctx.resolve(f);
        var node = ctx.vfs.get(abs, ctx.fsctx);
        if (!node) { ctx.errLine("chmod: cannot access '" + f + "': No such file or directory"); code = 1; return; }
        var mode;
        if (/^\d+$/.test(modeArg)) mode = parseInt(modeArg, 8);
        else {
          mode = node.mode;
          var m = modeArg.match(/^([ugoa]*)([+\-=])([rwxX]+)$/);
          if (!m) { ctx.errLine("chmod: invalid mode: '" + modeArg + "'"); code = 1; return; }
          var who = m[1] || 'a';
          var bits = 0;
          if (m[3].indexOf('r') >= 0) bits |= 4;
          if (m[3].indexOf('w') >= 0) bits |= 2;
          if (/[xX]/.test(m[3])) bits |= 1;
          var shifts = [];
          if (who.indexOf('u') >= 0 || who.indexOf('a') >= 0) shifts.push(6);
          if (who.indexOf('g') >= 0 || who.indexOf('a') >= 0) shifts.push(3);
          if (who.indexOf('o') >= 0 || who.indexOf('a') >= 0) shifts.push(0);
          shifts.forEach(function (s) {
            if (m[2] === '+') mode |= (bits << s);
            else if (m[2] === '-') mode &= ~(bits << s);
            else mode = (mode & ~(7 << s)) | (bits << s);
          });
        }
        function applyTo(path) {
          try { ctx.vfs.chmod(path, mode, ctx.fsctx); }
          catch (e) {
            ctx.errLine("chmod: changing permissions of '" + path + "': Operation not permitted");
            code = 1;
          }
        }
        if (p.flags.R) ctx.vfs.walkTree(abs, ctx.fsctx, function (path) { applyTo(path); });
        else applyTo(abs);
        if (p.flags.v) ctx.line("mode of '" + f + "' changed to 0" + mode.toString(8));
      });
      return code;
    }
  });

  reg({
    name: 'chown', category: 'sys', summary: 'сменить владельца', usage: 'chown [-R] USER[:GROUP] FILE...',
    complete: function (ctx, word, argv, h) { return h.path(ctx, word); },
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['R', 'v'] });
      if (p.rest.length < 2) return ctx.usageError('chown: missing operand');
      var spec = p.rest.shift().split(':');
      var db = ctx.machine.users;
      var u = spec[0] ? db.byName(spec[0]) : null;
      var g = spec[1] ? db.groupByName(spec[1]) : null;
      if (spec[0] && !u) return ctx.fail('chown: invalid user: ‘' + spec.join(':') + '’');
      if (spec[1] && !g) return ctx.fail('chown: invalid group: ‘' + spec.join(':') + '’');
      var code = 0;
      p.rest.forEach(function (f) {
        var abs = ctx.resolve(f);
        function applyTo(path) {
          try { ctx.vfs.chown(path, u ? u.uid : null, g ? g.gid : (u ? u.gid : null), ctx.fsctx); }
          catch (e) {
            ctx.errLine("chown: changing ownership of '" + path + "': Operation not permitted");
            code = 1;
          }
        }
        if (!ctx.vfs.get(abs, ctx.fsctx)) {
          ctx.errLine("chown: cannot access '" + f + "': No such file or directory");
          code = 1; return;
        }
        if (p.flags.R) ctx.vfs.walkTree(abs, ctx.fsctx, function (path) { applyTo(path); });
        else applyTo(abs);
      });
      return code;
    }
  });

  reg({
    name: 'chgrp', category: 'sys', summary: 'сменить группу', usage: 'chgrp GROUP FILE...',
    run: function (ctx) {
      if (ctx.argv.length < 2) return ctx.usageError('chgrp: missing operand');
      var g = ctx.machine.users.groupByName(ctx.argv[0]);
      if (!g) return ctx.fail('chgrp: invalid group: ‘' + ctx.argv[0] + '’');
      var code = 0;
      ctx.argv.slice(1).forEach(function (f) {
        try { ctx.vfs.chown(ctx.resolve(f), null, g.gid, ctx.fsctx); }
        catch (e) { ctx.errLine('chgrp: changing group of \'' + f + '\': Operation not permitted'); code = 1; }
      });
      return code;
    }
  });

  reg({
    name: 'umask', category: 'sys', summary: 'маска прав по умолчанию', usage: 'umask [MASK]',
    run: function (ctx) {
      if (!ctx.argv.length) {
        ctx.line('0' + ('000' + ctx.vfs.umask.toString(8)).slice(-3));
        return 0;
      }
      var m = parseInt(ctx.argv[0], 8);
      if (isNaN(m)) return ctx.fail('umask: ' + ctx.argv[0] + ': invalid symbolic mode');
      ctx.vfs.umask = m;
      return 0;
    }
  });

  /* ---------- пользователи ---------- */

  reg({
    name: 'useradd', aliases: ['adduser'], category: 'sys', summary: 'создать пользователя',
    usage: 'useradd [-m] [-G group] [-s shell] NAME',
    run: function (ctx) {
      if (!ctx.isRoot) return ctx.fail('useradd: Permission denied.');
      var p = A.parse(ctx.argv, { bool: ['m', 'r'], value: ['G', 's', 'g', 'd', 'c'] });
      var name = p.rest[0];
      if (!name) return ctx.usageError('Usage: useradd [options] LOGIN');
      if (ctx.machine.users.byName(name)) return ctx.fail('useradd: user \'' + name + '\' already exists', 9);
      var u = ctx.machine.users.addUser({
        name: name, shell: p.opts.s || '/bin/bash', home: p.opts.d || ('/home/' + name),
        extraGroups: p.opts.G ? p.opts.G.split(',') : [], gecos: p.opts.c || ''
      });
      if (p.flags.m) {
        try {
          ctx.vfs.mkdir(u.home, ctx.fsctx, { parents: true, mode: 0o750 });
          var n = ctx.vfs.get(u.home, ctx.fsctx);
          n.uid = u.uid; n.gid = u.gid;
        } catch (e) {}
      }
      ctx.machine.log('useradd', 'new user: name=' + name + ', UID=' + u.uid + ', GID=' + u.gid);
      return 0;
    }
  });

  reg({
    name: 'usermod', category: 'sys', summary: 'изменить пользователя', usage: 'usermod -aG GROUP USER',
    run: function (ctx) {
      if (!ctx.isRoot) return ctx.fail('usermod: Permission denied.');
      var p = A.parse(ctx.argv, { bool: ['a'], value: ['G', 's', 'L', 'U'] });
      var name = p.rest[0];
      var u = ctx.machine.users.byName(name);
      if (!u) return ctx.fail('usermod: user \'' + name + '\' does not exist', 6);
      if (p.opts.G) {
        p.opts.G.split(',').forEach(function (gn) {
          var g = ctx.machine.users.groupByName(gn) || ctx.machine.users.addGroup(gn);
          if (g.members.indexOf(name) < 0) g.members.push(name);
        });
      }
      if (p.opts.s) u.shell = p.opts.s;
      return 0;
    }
  });

  reg({
    name: 'groupadd', category: 'sys', summary: 'создать группу', usage: 'groupadd NAME',
    run: function (ctx) {
      if (!ctx.isRoot) return ctx.fail('groupadd: Permission denied.');
      if (!ctx.argv[0]) return ctx.usageError('Usage: groupadd [options] GROUP');
      if (ctx.machine.users.groupByName(ctx.argv[0])) {
        return ctx.fail('groupadd: group \'' + ctx.argv[0] + '\' already exists', 9);
      }
      ctx.machine.users.addGroup(ctx.argv[0]);
      return 0;
    }
  });

  reg({
    name: 'passwd', category: 'sys', summary: 'сменить пароль', usage: 'passwd [USER]',
    run: function (ctx) {
      var name = ctx.argv[0] || ctx.user;
      if (name !== ctx.user && !ctx.isRoot) return ctx.fail('passwd: You may not view or modify password information for ' + name + '.');
      ctx.line('passwd: password updated successfully');
      ctx.machine.log('passwd', 'password changed for ' + name);
      return 0;
    }
  });

  /* ---------- процессы ---------- */

  reg({
    name: 'ps', category: 'sys', summary: 'список процессов', usage: 'ps [aux] [-ef]',
    run: function (ctx) {
      var raw = ctx.argv.join(' ');
      var full = /aux|-ef|-e/.test(raw);
      var list = ctx.machine.procs.list.slice();
      if (!full) list = list.filter(function (p) { return p.user === ctx.user && p.tty !== '?'; });
      if (!full && !list.length) {
        list = [{ pid: ctx.session.shellPid, user: ctx.user, cmd: '-bash', tty: 'pts/0', cpu: 0, mem: 0.1, rss: 5400, vsz: 9800, state: 'Ss', start: Date.now() - 600000 }];
      }
      if (/aux/.test(raw)) {
        ctx.line(U.padRight('USER', 10) + U.pad('PID', 5) + ' ' + U.pad('%CPU', 4) + ' ' + U.pad('%MEM', 4) +
          U.pad('VSZ', 8) + U.pad('RSS', 7) + ' ' + U.padRight('TTY', 8) + U.padRight('STAT', 5) +
          U.padRight('START', 6) + U.padRight('TIME', 6) + 'COMMAND');
        list.forEach(function (p) {
          ctx.line(U.padRight(p.user, 10) + U.pad(p.pid, 5) + ' ' + U.pad(p.cpu.toFixed(1), 4) + ' ' +
            U.pad(p.mem.toFixed(1), 4) + U.pad(p.vsz, 8) + U.pad(p.rss, 7) + ' ' +
            U.padRight(p.tty, 8) + U.padRight(p.state, 5) +
            U.padRight(U.lsTime(p.start).split(' ').slice(-1)[0], 6) +
            U.padRight('0:00', 6) + p.cmd);
        });
        return 0;
      }
      ctx.line(U.padRight('UID', 10) + U.pad('PID', 6) + U.pad('PPID', 6) + '  C STIME TTY          TIME CMD');
      list.forEach(function (p) {
        ctx.line(U.padRight(p.user, 10) + U.pad(p.pid, 6) + U.pad(p.ppid, 6) + '  0 ' +
          U.padRight(U.lsTime(p.start).split(' ').slice(-1)[0], 6) + U.padRight(p.tty, 12) +
          ' 00:00:00 ' + p.cmd);
      });
      return 0;
    }
  });

  reg({
    name: 'top', category: 'sys', summary: 'снимок нагрузки', usage: 'top [-bn1]',
    run: function (ctx) {
      var m = ctx.machine;
      var d = new Date();
      ctx.line('top - ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes()) + ':' + U.pad2(d.getSeconds()) +
        ' up ' + m.procs.uptimeString() + ',  1 user,  load average: 0.' + U.randInt(10, 50) + ', 0.' +
        U.randInt(10, 40) + ', 0.' + U.randInt(5, 30));
      ctx.line('Tasks: ' + U.pad(m.procs.list.length + 110, 3) + ' total,   1 running, ' +
        U.pad(m.procs.list.length + 109, 3) + ' sleeping,   0 stopped,   0 zombie');
      ctx.line('%Cpu(s):  1.3 us,  0.7 sy,  0.0 ni, 97.8 id,  0.2 wa,  0.0 hi,  0.0 si,  0.0 st');
      ctx.line('MiB Mem :   3928.0 total,   1787.0 free,    824.0 used,   1317.0 buff/cache');
      ctx.line('MiB Swap:   2048.0 total,   2048.0 free,      0.0 used.   2846.0 avail Mem');
      ctx.line('');
      ctx.line('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');
      m.procs.list.slice().sort(function (a, b) { return b.cpu - a.cpu; }).slice(0, 14).forEach(function (p) {
        ctx.line(U.pad(p.pid, 7) + ' ' + U.padRight(p.user, 10) + '20   0' + U.pad(p.vsz, 8) + U.pad(p.rss, 7) +
          U.pad(Math.round(p.rss / 3), 7) + ' S ' + U.pad(p.cpu.toFixed(1), 5) + ' ' +
          U.pad(p.mem.toFixed(1), 5) + '   0:0' + U.randInt(0, 9) + '.' + U.randInt(10, 99) + ' ' +
          p.cmd.split(' ')[0].split('/').pop());
      });
      return 0;
    }
  });

  reg({
    name: 'kill', category: 'sys', summary: 'послать сигнал процессу', usage: 'kill [-9|-TERM|-HUP] PID...',
    run: function (ctx) {
      var signal = 'TERM';
      var args = ctx.argv.slice();
      if (args.length && args[0][0] === '-') {
        signal = args.shift().slice(1).replace(/^SIG/, '');
        if (signal === 's') signal = args.shift();
      }
      if (!args.length) return ctx.usageError('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid');
      var code = 0;
      args.forEach(function (pidStr) {
        var pid = parseInt(pidStr, 10);
        if (isNaN(pid)) { ctx.errLine('kill: ' + pidStr + ': arguments must be process or job IDs'); code = 1; return; }
        var r = ctx.machine.procs.kill(pid, signal, ctx.fsctx);
        if (!r.ok) { ctx.errLine('kill: (' + pid + '): ' + r.err); code = 1; }
      });
      return code;
    }
  });

  reg({
    name: 'pkill', category: 'sys', summary: 'убить процессы по имени', usage: 'pkill [-9] PATTERN',
    run: function (ctx) {
      var signal = 'TERM';
      var args = ctx.argv.slice();
      if (args.length && args[0][0] === '-' && !/^-[ufx]$/.test(args[0])) signal = args.shift().slice(1);
      var pattern = args[0];
      if (!pattern) return ctx.usageError('pkill: no matching criteria specified');
      var found = ctx.machine.procs.find(pattern);
      if (!found.length) return 1;
      found.forEach(function (p) { ctx.machine.procs.kill(p.pid, signal, ctx.fsctx); });
      return 0;
    }
  });

  reg({
    name: 'killall', category: 'sys', summary: 'убить процессы по имени', usage: 'killall NAME',
    run: function (ctx) {
      var name = ctx.argv[ctx.argv.length - 1];
      var signal = ctx.argv[0] && ctx.argv[0][0] === '-' ? ctx.argv[0].slice(1) : 'TERM';
      var list = ctx.machine.procs.byName(name);
      if (!list.length) return ctx.fail(name + ': no process found');
      list.forEach(function (p) { ctx.machine.procs.kill(p.pid, signal, ctx.fsctx); });
      return 0;
    }
  });

  reg({
    name: 'pgrep', category: 'sys', summary: 'найти PID по имени', usage: 'pgrep PATTERN',
    run: function (ctx) {
      var list = ctx.machine.procs.find(ctx.argv[ctx.argv.length - 1] || '');
      list.forEach(function (p) { ctx.line(String(p.pid)); });
      return list.length ? 0 : 1;
    }
  });

  /* ---------- окружение и система ---------- */

  reg({
    name: 'env', aliases: ['printenv'], category: 'sys', summary: 'переменные окружения', usage: 'env',
    run: function (ctx) {
      if (ctx.argv.length && ctx.argv0 === 'printenv') {
        var v = ctx.env[ctx.argv[0]];
        if (v === undefined) return 1;
        ctx.line(v);
        return 0;
      }
      Object.keys(ctx.env).sort().forEach(function (k) { ctx.line(k + '=' + ctx.env[k]); });
      return 0;
    }
  });

  reg({
    name: 'export', category: 'sys', summary: 'задать переменную окружения', usage: 'export VAR=value',
    run: function (ctx) {
      if (!ctx.argv.length) {
        Object.keys(ctx.env).sort().forEach(function (k) { ctx.line('declare -x ' + k + '="' + ctx.env[k] + '"'); });
        return 0;
      }
      var code = 0;
      ctx.argv.forEach(function (a) {
        var eq = a.indexOf('=');
        if (eq < 0) return;
        var name = a.slice(0, eq);
        if (NET.schema.isUnsafeKey(name)) {
          ctx.errLine('export: `' + name + '\': not a valid identifier');
          code = 1;
          return;
        }
        ctx.env[name] = a.slice(eq + 1);
      });
      return code;
    }
  });

  reg({
    name: 'unset', category: 'sys', summary: 'удалить переменную', usage: 'unset VAR',
    run: function (ctx) {
      ctx.argv.forEach(function (a) {
        if (!NET.schema.isUnsafeKey(a)) delete ctx.env[a];
      });
      return 0;
    }
  });

  reg({
    name: 'alias', category: 'sys', summary: 'псевдонимы команд', usage: 'alias [name=value]',
    run: function (ctx) {
      if (!ctx.argv.length) {
        Object.keys(ctx.session.aliases).sort().forEach(function (k) {
          ctx.line("alias " + k + "='" + ctx.session.aliases[k] + "'");
        });
        return 0;
      }
      ctx.argv.forEach(function (a) {
        var eq = a.indexOf('=');
        if (eq > 0) ctx.session.aliases[a.slice(0, eq)] = a.slice(eq + 1).replace(/^['"]|['"]$/g, '');
      });
      return 0;
    }
  });

  reg({
    name: 'uname', category: 'sys', summary: 'информация о системе', usage: 'uname [-a|-r|-n]',
    run: function (ctx) {
      var m = ctx.machine;
      var p = A.parse(ctx.argv, { bool: ['a', 'r', 'n', 's', 'm', 'v'] });
      if (p.flags.a) {
        ctx.line('Linux ' + m.hostname + ' ' + m.kernel + ' #45-Ubuntu SMP PREEMPT_DYNAMIC x86_64 x86_64 x86_64 GNU/Linux');
      } else if (p.flags.r) ctx.line(m.kernel);
      else if (p.flags.n) ctx.line(m.hostname);
      else if (p.flags.m) ctx.line('x86_64');
      else ctx.line('Linux');
      return 0;
    }
  });

  reg({
    name: 'hostname', category: 'sys', summary: 'имя хоста', usage: 'hostname [-I] [NAME]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['I', 'i', 'f'] });
      if (p.flags.I || p.flags.i) {
        var ips = [];
        ctx.machine.net.ifaces.forEach(function (i) {
          if (i.type === 'loopback') return;
          i.addrs.forEach(function (a) { if (a.family === 4) ips.push(a.ip); });
        });
        ctx.line(ips.join(' '));
        return 0;
      }
      if (p.rest.length) {
        if (!ctx.isRoot) return ctx.fail('hostname: you must be root to change the host name');
        ctx.machine.hostname = p.rest[0];
        ctx.env.HOSTNAME = p.rest[0];
        NET.bus.emit('shell:user-changed', {});
        return 0;
      }
      ctx.line(ctx.machine.hostname);
      return 0;
    }
  });

  reg({
    name: 'hostnamectl', category: 'sys', summary: 'информация о хосте', usage: 'hostnamectl [set-hostname NAME]',
    run: function (ctx) {
      var m = ctx.machine;
      if (ctx.argv[0] === 'set-hostname') {
        if (!ctx.isRoot) return ctx.fail('Could not set property: Access denied');
        m.hostname = ctx.argv[1];
        return 0;
      }
      ctx.line(' Static hostname: ' + m.hostname);
      ctx.line('       Icon name: computer-vm');
      ctx.line('         Chassis: vm');
      ctx.line('  Virtualization: vmware');
      ctx.line('Operating System: ' + m.osRelease);
      ctx.line('          Kernel: Linux ' + m.kernel);
      ctx.line('    Architecture: x86-64');
      return 0;
    }
  });

  reg({
    name: 'uptime', category: 'sys', summary: 'время работы', usage: 'uptime',
    run: function (ctx) {
      var d = new Date();
      ctx.line(' ' + U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes()) + ':' + U.pad2(d.getSeconds()) +
        ' up ' + ctx.machine.procs.uptimeString() + ',  1 user,  load average: 0.' +
        U.randInt(10, 50) + ', 0.' + U.randInt(10, 40) + ', 0.' + U.randInt(5, 30));
      return 0;
    }
  });

  reg({
    name: 'free', category: 'sys', summary: 'память', usage: 'free [-h] [-m]',
    run: function (ctx) {
      var h = ctx.argv.indexOf('-h') >= 0;
      var m = ctx.argv.indexOf('-m') >= 0;
      function f(kb) {
        if (h) return U.humanSize(kb * 1024) + 'i';
        if (m) return String(Math.round(kb / 1024));
        return String(kb);
      }
      ctx.line(U.padRight('', 15) + U.pad('total', 11) + U.pad('used', 11) + U.pad('free', 11) +
        U.pad('shared', 11) + U.pad('buff/cache', 12) + U.pad('available', 11));
      ctx.line(U.padRight('Mem:', 15) + U.pad(f(4022204), 11) + U.pad(f(843776), 11) + U.pad(f(1830112), 11) +
        U.pad(f(12288), 11) + U.pad(f(1348316), 12) + U.pad(f(2914320), 11));
      ctx.line(U.padRight('Swap:', 15) + U.pad(f(2097148), 11) + U.pad(f(0), 11) + U.pad(f(2097148), 11));
      return 0;
    }
  });

  reg({
    name: 'date', category: 'sys', summary: 'дата и время', usage: 'date',
    run: function (ctx) {
      ctx.line(new Date().toString().replace(/GMT.*/, 'UTC ' + new Date().getFullYear()));
      return 0;
    }
  });

  reg({
    name: 'sysctl', category: 'net', summary: 'параметры ядра', usage: 'sysctl [-a] [-w] key[=value]',
    complete: function (ctx, word) {
      return Object.keys(ctx.machine.net.sysctl).filter(function (k) { return k.indexOf(word) === 0; });
    },
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['a', 'w', 'p'] });
      var sc = ctx.machine.net.sysctl;
      if (p.flags.a || !p.rest.length) {
        Object.keys(sc).sort().forEach(function (k) { ctx.line(k + ' = ' + sc[k]); });
        return 0;
      }
      var code = 0;
      p.rest.forEach(function (arg) {
        var eq = arg.indexOf('=');
        if (eq > 0) {
          if (!ctx.isRoot) { ctx.errLine('sysctl: permission denied on key "' + arg.slice(0, eq) + '"'); code = 1; return; }
          var k = arg.slice(0, eq).trim(), v = arg.slice(eq + 1).trim();
          sc[k] = v;
          ctx.line(k + ' = ' + v);
          if (k === 'net.ipv4.ip_forward') {
            ctx.machine.log('kernel', 'ip_forward set to ' + v);
          }
        } else {
          if (sc[arg] === undefined) { ctx.errLine('sysctl: cannot stat /proc/sys/' + arg.replace(/\./g, '/') + ': No such file or directory'); code = 1; return; }
          ctx.line(arg + ' = ' + sc[arg]);
        }
      });
      return code;
    }
  });

  reg({
    name: 'reboot', category: 'sys', summary: 'перезагрузить виртуальную машину', usage: 'reboot',
    run: function (ctx) {
      if (!ctx.isRoot) return ctx.fail('reboot: Interactive authentication required.');
      ctx.line('Connection to ' + ctx.machine.hostname + ' closed by remote host.');
      ctx.machine.reboot();
      ctx.line('[  OK  ] Reached target Multi-User System.');
      ctx.line('Ubuntu ' + ctx.machine.osRelease + ' ' + ctx.machine.hostname + ' tty1');
      ctx.line('');
      ctx.line('После перезагрузки применена только постоянная конфигурация ' +
        '(/etc/netplan, NetworkManager, включённые юниты).');
      NET.bus.emit('machine:rebooted', { machine: ctx.machine.name });
      return 0;
    }
  });

  reg({
    name: 'which', category: 'sys', summary: 'путь до команды', usage: 'which COMMAND',
    run: function (ctx) {
      var code = 0;
      ctx.argv.forEach(function (name) {
        var cmd = NET.commands.get(name);
        if (!cmd) { code = 1; return; }
        var dir = (cmd.category === 'net' || cmd.category === 'firewall') ? '/usr/sbin/' : '/usr/bin/';
        ctx.line(dir + name);
      });
      return code;
    }
  });
})(window.NET);
