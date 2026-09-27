/*
 * fs.js — команды файловой системы.
 * Все работают через VFS с реальными правами: ошибки и exit codes такие же,
 * как в Ubuntu (2 — нет файла, 1 — нет прав).
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var C = NET.cmdlib;
  var reg = NET.commands.register;
  var fsErr = C.fsError;

  function pathComplete(ctx, word, argv, h) { return h.path(ctx, word); }

  /* ---------- pwd / cd ---------- */

  reg({
    name: 'pwd', category: 'fs', summary: 'показать текущий каталог',
    usage: 'pwd',
    run: function (ctx) { ctx.line(ctx.cwd); return 0; }
  });

  reg({
    name: 'cd', category: 'fs', summary: 'сменить каталог',
    usage: 'cd [DIR]',
    complete: function (ctx, word, argv, h) { return h.path(ctx, word, { dirsOnly: true }); },
    run: function (ctx) {
      var st = ctx.session.state(ctx.machine);
      var target = ctx.argv[0];
      if (!target || target === '~') target = ctx.env.HOME;
      else if (target === '-') target = ctx.env.OLDPWD || ctx.cwd;
      else if (target[0] === '~') target = ctx.env.HOME + target.slice(1);
      var abs = ctx.vfs.normalize(target, ctx.cwd);
      var node;
      try { node = ctx.vfs.walk(abs, ctx.fsctx).node; } catch (e) { return fsErr(ctx, 'cd', e, abs); }
      if (!node) { ctx.errLine('cd: ' + target + ': No such file or directory'); return 1; }
      if (node.type !== 'dir') { ctx.errLine('cd: ' + target + ': Not a directory'); return 1; }
      if (!ctx.vfs.can(node, ctx.fsctx, 'x')) { ctx.errLine('cd: ' + target + ': Permission denied'); return 1; }
      ctx.env.OLDPWD = st.cwd;
      st.cwd = abs;
      ctx.env.PWD = abs;
      if (ctx.argv[0] === '-') ctx.line(abs);
      return 0;
    }
  });

  /* ---------- ls ---------- */

  reg({
    name: 'ls', category: 'fs', summary: 'список файлов',
    usage: 'ls [-l] [-a] [-h] [-R] [-t] [FILE...]',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['l', 'a', 'A', 'h', 'R', 't', 'r', 'd', 'F', 'i', '1', 'all', 'long'] });
      var targets = p.rest.length ? p.rest : ['.'];
      var long = p.flags.l || p.flags.long;
      var all = p.flags.a || p.flags.A || p.flags.all;
      var code = 0;
      var many = targets.length > 1;
      var first = true;

      targets.forEach(function (t) {
        var abs = ctx.resolve(t);
        var node;
        try { node = ctx.vfs.walk(abs, ctx.fsctx).node; } catch (e) { code = fsErr(ctx, 'ls', e, t); return; }
        if (!node) { ctx.errLine("ls: cannot access '" + t + "': No such file or directory"); code = 2; return; }
        if (many || p.flags.R) {
          if (!first) ctx.line('');
          if (node.type === 'dir') ctx.line(t + ':');
          first = false;
        }
        if (node.type !== 'dir' || p.flags.d) {
          printEntries(ctx, [{ name: t, node: node, path: abs }], p);
          return;
        }
        var entries;
        try { entries = ctx.vfs.list(abs, ctx.fsctx); } catch (e) { code = fsErr(ctx, 'ls', e, t); return; }
        if (!all) entries = entries.filter(function (e) { return e.name[0] !== '.'; });
        if (p.flags.a) {
          entries = [{ name: '.', node: node, path: abs },
            { name: '..', node: ctx.vfs.get(ctx.vfs.dirname(abs), ctx.fsctx) || node, path: ctx.vfs.dirname(abs) }]
            .concat(entries);
        }
        if (p.flags.t) entries.sort(function (a, b) { return b.node.mtime - a.node.mtime; });
        if (p.flags.r) entries.reverse();
        printEntries(ctx, entries, p);
        if (p.flags.R) {
          entries.forEach(function (e) {
            if (e.node.type === 'dir' && e.name !== '.' && e.name !== '..') {
              ctx.line('');
              ctx.line((t === '.' ? './' : t + '/') + e.name + ':');
              var sub;
              try { sub = ctx.vfs.list(e.path, ctx.fsctx); } catch (err) { return; }
              if (!all) sub = sub.filter(function (x) { return x.name[0] !== '.'; });
              printEntries(ctx, sub, p);
            }
          });
        }
      });
      return code;
    }
  });

  function printEntries(ctx, entries, p) {
    var vfs = ctx.vfs;
    if (p.flags.l || p.flags.long) {
      var total = 0;
      entries.forEach(function (e) { total += Math.ceil(vfs.size(e.node) / 1024) * 4 || 4; });
      if (entries.length && entries[0].name !== ctx.argv[0]) ctx.line('total ' + total);
      entries.forEach(function (e) {
        var n = e.node;
        var owner = ctx.machine.users.byUid(n.uid);
        var group = ctx.machine.users.groupByGid(n.gid);
        var size = p.flags.h ? U.humanSize(vfs.size(n)) : String(vfs.size(n));
        var name = e.name;
        if (n.type === 'link') name += ' -> ' + n.target;
        ctx.line(vfs.modeString(n) + ' ' + U.pad(n.nlink || 1, 2) + ' ' +
          U.padRight(owner ? owner.name : n.uid, 8) + ' ' +
          U.padRight(group ? group.name : n.gid, 8) + ' ' +
          U.pad(size, 8) + ' ' + U.lsTime(n.mtime) + ' ' + name);
      });
      return;
    }
    var names = entries.map(function (e) {
      var s = e.name;
      if (p.flags.F) {
        if (e.node.type === 'dir') s += '/';
        else if (e.node.type === 'link') s += '@';
        else if (e.node.mode & 0o111) s += '*';
      }
      return s;
    });
    if (p.flags['1'] || names.length <= 1) names.forEach(function (n) { ctx.line(n); });
    else ctx.line(U.columns(names, 80));
  }

  /* ---------- создание / удаление ---------- */

  reg({
    name: 'mkdir', category: 'fs', summary: 'создать каталог', usage: 'mkdir [-p] DIR...',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['p', 'parents', 'v'], value: ['m', 'mode'] });
      if (!p.rest.length) return ctx.usageError('mkdir: missing operand');
      var code = 0;
      p.rest.forEach(function (d) {
        try {
          ctx.vfs.mkdir(ctx.resolve(d), ctx.fsctx, {
            parents: p.flags.p || p.flags.parents,
            mode: p.opts.m ? parseInt(p.opts.m, 8) : undefined
          });
          if (p.flags.v) ctx.line("mkdir: created directory '" + d + "'");
        } catch (e) { code = fsErr(ctx, 'mkdir', e, d); }
      });
      return code;
    }
  });

  reg({
    name: 'rmdir', category: 'fs', summary: 'удалить пустой каталог', usage: 'rmdir DIR...',
    complete: pathComplete,
    run: function (ctx) {
      if (!ctx.argv.length) return ctx.usageError('rmdir: missing operand');
      var code = 0;
      ctx.argv.forEach(function (d) {
        try { ctx.vfs.rmdir(ctx.resolve(d), ctx.fsctx); } catch (e) { code = fsErr(ctx, 'rmdir', e, d); }
      });
      return code;
    }
  });

  reg({
    name: 'touch', category: 'fs', summary: 'создать файл / обновить время', usage: 'touch FILE...',
    complete: pathComplete,
    run: function (ctx) {
      if (!ctx.argv.length) return ctx.usageError('touch: missing file operand');
      var code = 0;
      ctx.argv.forEach(function (f) {
        try { ctx.vfs.touch(ctx.resolve(f), ctx.fsctx); } catch (e) { code = fsErr(ctx, 'touch', e, f); }
      });
      return code;
    }
  });

  reg({
    name: 'rm', category: 'fs', summary: 'удалить файл или каталог', usage: 'rm [-r] [-f] FILE...',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['r', 'R', 'f', 'i', 'v', 'recursive', 'force'] });
      if (!p.rest.length) return p.flags.f ? 0 : ctx.usageError('rm: missing operand');
      var rec = p.flags.r || p.flags.R || p.flags.recursive;
      var force = p.flags.f || p.flags.force;
      var code = 0;
      p.rest.forEach(function (f) {
        var abs = ctx.resolve(f);
        if (abs === '/' && rec) {
          ctx.errLine('rm: it is dangerous to operate recursively on \'/\'');
          code = 1; return;
        }
        try {
          ctx.vfs.unlink(abs, ctx.fsctx, { recursive: rec });
          if (p.flags.v) ctx.line("removed '" + f + "'");
        } catch (e) {
          if (force && e.code === 'ENOENT') return;
          code = fsErr(ctx, 'rm', e, f);
        }
      });
      return code;
    }
  });

  reg({
    name: 'cp', category: 'fs', summary: 'копировать', usage: 'cp [-r] SRC... DEST',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['r', 'R', 'a', 'v', 'p', 'f', 'recursive'] });
      if (p.rest.length < 2) return ctx.usageError('cp: missing destination file operand');
      var dest = p.rest.pop();
      var rec = p.flags.r || p.flags.R || p.flags.a || p.flags.recursive;
      var code = 0;
      p.rest.forEach(function (src) {
        try {
          ctx.vfs.copy(ctx.resolve(src), ctx.resolve(dest), ctx.fsctx, { recursive: rec });
          if (p.flags.v) ctx.line("'" + src + "' -> '" + dest + "'");
        } catch (e) {
          if (e.code === 'EISDIR' && !rec) {
            ctx.errLine("cp: -r not specified; omitting directory '" + src + "'");
            code = 1;
          } else code = fsErr(ctx, 'cp', e, src);
        }
      });
      return code;
    }
  });

  reg({
    name: 'mv', category: 'fs', summary: 'переместить / переименовать', usage: 'mv SRC... DEST',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['f', 'v', 'n'] });
      if (p.rest.length < 2) return ctx.usageError('mv: missing destination file operand');
      var dest = p.rest.pop();
      var code = 0;
      p.rest.forEach(function (src) {
        try {
          ctx.vfs.rename(ctx.resolve(src), ctx.resolve(dest), ctx.fsctx);
          if (p.flags.v) ctx.line("renamed '" + src + "' -> '" + dest + "'");
        } catch (e) { code = fsErr(ctx, 'mv', e, src); }
      });
      return code;
    }
  });

  reg({
    name: 'ln', category: 'fs', summary: 'создать ссылку', usage: 'ln -s TARGET LINK',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['s', 'f'] });
      if (p.rest.length < 2) return ctx.usageError('ln: missing file operand');
      try {
        if (p.flags.f) { try { ctx.vfs.unlink(ctx.resolve(p.rest[1]), ctx.fsctx); } catch (e) {} }
        ctx.vfs.symlink(p.rest[0], ctx.resolve(p.rest[1]), ctx.fsctx);
      } catch (e) { return fsErr(ctx, 'ln', e, p.rest[1]); }
      return 0;
    }
  });

  /* ---------- чтение ---------- */

  reg({
    name: 'cat', category: 'fs', summary: 'вывести файл', usage: 'cat [-n] [FILE...]',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['n', 'A', 'E', 'number'] });
      if (!p.rest.length) { ctx.out(ctx.stdin); return 0; }
      var code = 0, lineNo = 1;
      p.rest.forEach(function (f) {
        var data;
        if (f === '-') data = ctx.stdin;
        else {
          try { data = ctx.vfs.read(ctx.resolve(f), ctx.fsctx); }
          catch (e) { code = fsErr(ctx, 'cat', e, f); return; }
        }
        if (p.flags.n || p.flags.number) {
          data.replace(/\n$/, '').split('\n').forEach(function (l) {
            ctx.line(U.pad(lineNo++, 6) + '\t' + l);
          });
        } else ctx.out(data);
      });
      return code;
    }
  });

  reg({
    name: 'head', category: 'fs', summary: 'первые строки', usage: 'head [-n N] [FILE...]',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { value: ['n', 'lines', 'c'] });
      var raw = p.opts.n === undefined ? p.opts.lines : p.opts.n;
      var n = raw === undefined ? 10 : C.intArg(ctx, 'head', raw, 10, { min: 0, max: 100000, notify: false });
      if (n === null) return 1;
      var data = readInput(ctx, p.rest);
      if (data === null) return 1;
      var lines = data.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      ctx.out(lines.slice(0, n).join('\n') + (lines.length ? '\n' : ''));
      return 0;
    }
  });

  reg({
    name: 'tail', category: 'fs', summary: 'последние строки', usage: 'tail [-n N] [-f] [FILE...]',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { value: ['n', 'lines'], bool: ['f', 'F', 'follow'] });
      var nRaw = String(p.opts.n === undefined ? (p.opts.lines === undefined ? '10' : p.opts.lines) : p.opts.n);
      var plus = nRaw[0] === '+';
      var n = C.intArg(ctx, 'tail', nRaw.replace('+', ''), 10, { min: 0, max: 100000, notify: false });
      if (n === null) return 1;
      var data = readInput(ctx, p.rest);
      if (data === null) return 1;
      var lines = data.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      var out = plus ? lines.slice(n - 1) : lines.slice(Math.max(0, lines.length - n));
      ctx.out(out.join('\n') + (out.length ? '\n' : ''));
      if (p.flags.f || p.flags.follow) {
        ctx.line('^C');   // «следование» в тренажёре завершается сразу
      }
      return 0;
    }
  });

  function readInput(ctx, files) {
    return C.readFiles(ctx, files, ctx.argv0, { headers: true });
  }

  reg({
    name: 'less', aliases: ['more'], category: 'fs', summary: 'постраничный просмотр',
    usage: 'less FILE', complete: pathComplete,
    run: function (ctx) {
      var data = ctx.argv.length ? readInput(ctx, ctx.argv.filter(function (a) { return a[0] !== '-'; })) : ctx.stdin;
      if (data === null) return 1;
      if (ctx.session.onPager && ctx.streaming) {
        ctx.session.onPager(data, ctx.argv[0] || 'stdin');
        return 0;
      }
      ctx.out(data);
      return 0;
    }
  });

  reg({
    name: 'stat', category: 'fs', summary: 'метаданные файла', usage: 'stat FILE',
    complete: pathComplete,
    run: function (ctx) {
      if (!ctx.argv.length) return ctx.usageError('stat: missing operand');
      var code = 0;
      ctx.argv.forEach(function (f) {
        var abs = ctx.resolve(f);
        var n;
        try { n = ctx.vfs.walk(abs, ctx.fsctx).node; } catch (e) { code = fsErr(ctx, 'stat', e, f); return; }
        if (!n) { ctx.errLine("stat: cannot statx '" + f + "': No such file or directory"); code = 1; return; }
        var owner = ctx.machine.users.byUid(n.uid);
        var group = ctx.machine.users.groupByGid(n.gid);
        ctx.line('  File: ' + f);
        ctx.line('  Size: ' + U.padRight(ctx.vfs.size(n), 10) + '\tBlocks: 8          IO Block: 4096   ' +
          (n.type === 'dir' ? 'directory' : (n.type === 'link' ? 'symbolic link' : 'regular file')));
        ctx.line('Device: 8,1\tInode: ' + U.randInt(100000, 999999) + '\tLinks: ' + (n.nlink || 1));
        ctx.line('Access: (' + ('0000' + n.mode.toString(8)).slice(-4) + '/' + ctx.vfs.modeString(n) + ')  Uid: (' +
          U.pad(n.uid, 5) + '/' + U.padRight(owner ? owner.name : '?', 8) + ')   Gid: (' +
          U.pad(n.gid, 5) + '/' + U.padRight(group ? group.name : '?', 8) + ')');
        ctx.line('Modify: ' + new Date(n.mtime).toISOString().replace('T', ' ').slice(0, 19));
      });
      return code;
    }
  });

  reg({
    name: 'file', category: 'fs', summary: 'тип файла', usage: 'file FILE...',
    complete: pathComplete,
    run: function (ctx) {
      ctx.argv.forEach(function (f) {
        var n = ctx.vfs.get(ctx.resolve(f), ctx.fsctx);
        if (!n) { ctx.line(f + ': cannot open (No such file or directory)'); return; }
        if (n.type === 'dir') { ctx.line(f + ': directory'); return; }
        if (n.type === 'link') { ctx.line(f + ': symbolic link to ' + n.target); return; }
        var content = ctx.vfs.contentOf(n);
        if (/^#!/.test(content)) ctx.line(f + ': a ' + content.split('\n')[0].slice(2) + ' script, ASCII text executable');
        else ctx.line(f + ': ASCII text');
      });
      return 0;
    }
  });

  reg({
    name: 'find', category: 'fs', summary: 'поиск файлов',
    usage: 'find [PATH] [-name PATTERN] [-type f|d] [-mmin -N] [-size +N]',
    complete: pathComplete,
    run: function (ctx) {
      var args = ctx.argv.slice();
      var paths = [];
      while (args.length && args[0][0] !== '-') paths.push(args.shift());
      if (!paths.length) paths = ['.'];
      var tests = [];
      var printOnly = true;
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a === '-name' || a === '-iname') {
          var pat = args[++i] || '';
          var re = C.globRegex(ctx, 'find', pat, a === '-iname' ? 'i' : '');
          if (!re) return 2;
          tests.push(function (p, n) { return re.test(p.slice(p.lastIndexOf('/') + 1)); });
        } else if (a === '-type') {
          var t = args[++i];
          tests.push(function (p, n) {
            return (t === 'f' && n.type === 'file') || (t === 'd' && n.type === 'dir') || (t === 'l' && n.type === 'link');
          });
        } else if (a === '-mmin') {
          var v = args[++i];
          var mins = Math.abs(parseInt(v, 10));
          var newer = v[0] === '-';
          tests.push(function (p, n) {
            var age = (Date.now() - n.mtime) / 60000;
            return newer ? age <= mins : age > mins;
          });
        } else if (a === '-size') {
          var sv = args[++i] || '';
          var bigger = sv[0] === '+';
          var bytes = parseInt(sv.replace(/[+\-]/, ''), 10) * (/M$/.test(sv) ? 1048576 : (/k$/i.test(sv) ? 1024 : 512));
          tests.push(function (p, n) {
            var s = ctx.vfs.size(n);
            return bigger ? s > bytes : s < bytes;
          });
        } else if (a === '-maxdepth') {
          var d = parseInt(args[++i], 10);
          tests.push(function (p, n, depth) { return depth <= d; });
        } else if (a === '-exec') {
          printOnly = false;
          var cmdParts = [];
          while (args[++i] && args[i] !== ';' && args[i] !== '\;') cmdParts.push(args[i]);
          tests.execCmd = cmdParts;
        }
      }
      var results = [];
      paths.forEach(function (p) {
        var base = ctx.resolve(p);
        if (!ctx.vfs.get(base, ctx.fsctx)) {
          ctx.errLine("find: '" + p + "': No such file or directory");
          return;
        }
        ctx.vfs.walkTree(base, ctx.fsctx, function (path, node, depth) {
          var display = p === '.' ? '.' + path.slice(base === '/' ? 0 : base.length) : path;
          if (display === '.' + '') display = '.';
          var ok = tests.every(function (t) { return t(path, node, depth); });
          if (ok) results.push(display === '' ? p : display);
        });
      });
      results.forEach(function (r) { ctx.line(r); });
      return 0;
    }
  });

  reg({
    name: 'tree', category: 'fs', summary: 'дерево каталогов', usage: 'tree [-L N] [DIR]',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { value: ['L'] });
      var maxDepth = A.num(p.opts.L, 3);
      var base = ctx.resolve(p.rest[0] || '.');
      var dirs = 0, files = 0;
      ctx.line(p.rest[0] || '.');
      function walk(path, prefix, depth) {
        if (depth > maxDepth) return;
        var entries;
        try { entries = ctx.vfs.list(path, ctx.fsctx); } catch (e) { return; }
        entries = entries.filter(function (e) { return e.name[0] !== '.'; });
        entries.forEach(function (e, i) {
          var last = i === entries.length - 1;
          ctx.line(prefix + (last ? '└── ' : '├── ') + e.name);
          if (e.node.type === 'dir') { dirs++; walk(e.path, prefix + (last ? '    ' : '│   '), depth + 1); }
          else files++;
        });
      }
      walk(base, '', 1);
      ctx.line('');
      ctx.line(dirs + ' directories, ' + files + ' files');
      return 0;
    }
  });

  reg({
    name: 'du', category: 'fs', summary: 'размер каталога', usage: 'du [-sh] [DIR]',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['s', 'h', 'a'] });
      var base = ctx.resolve(p.rest[0] || '.');
      var total = 0;
      ctx.vfs.walkTree(base, ctx.fsctx, function (path, n) { total += ctx.vfs.size(n); });
      var val = p.flags.h ? U.humanSize(total) : Math.ceil(total / 1024);
      ctx.line(val + '\t' + (p.rest[0] || '.'));
      return 0;
    }
  });

  reg({
    name: 'df', category: 'fs', summary: 'использование дисков', usage: 'df [-h]',
    run: function (ctx) {
      var h = ctx.argv.indexOf('-h') >= 0;
      ctx.line(U.padRight('Filesystem', 16) + U.pad(h ? 'Size' : '1K-blocks', 10) + U.pad('Used', 10) +
        U.pad('Avail', 10) + U.pad('Use%', 5) + ' Mounted on');
      var rows = [
        ['/dev/sda2', 41922560, 8734208, 31048192, '/'],
        ['tmpfs', 2011100, 0, 2011100, '/dev/shm'],
        ['/dev/sda1', 1046512, 6220, 1040292, '/boot/efi']
      ];
      rows.forEach(function (r) {
        var size = h ? U.humanSize(r[1] * 1024) : r[1];
        var used = h ? U.humanSize(r[2] * 1024) : r[2];
        var avail = h ? U.humanSize(r[3] * 1024) : r[3];
        var pct = Math.round(r[2] / r[1] * 100) + '%';
        ctx.line(U.padRight(r[0], 16) + U.pad(size, 10) + U.pad(used, 10) + U.pad(avail, 10) +
          U.pad(pct, 5) + ' ' + r[4]);
      });
      return 0;
    }
  });

  reg({
    name: 'readlink', category: 'fs', summary: 'цель символической ссылки', usage: 'readlink [-f] FILE',
    complete: pathComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['f'] });
      var abs = ctx.resolve(p.rest[0] || '');
      var r;
      try { r = ctx.vfs.walk(abs, ctx.fsctx, { follow: false }); } catch (e) { return 1; }
      if (!r.node) return 1;
      if (r.node.type !== 'link' && !p.flags.f) return 1;
      ctx.line(r.node.type === 'link' ? r.node.target : abs);
      return 0;
    }
  });

})(window.NET);
