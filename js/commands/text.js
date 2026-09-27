/*
 * text.js — обработка текста: именно эти команды превращают вывод
 * сетевых утилит в ответ на вопрос («какой процесс слушает 443?»).
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var C = NET.cmdlib;
  var reg = NET.commands.register;

  function input(ctx, files) { return C.readFiles(ctx, files, ctx.argv0); }
  var lines = C.lines;

  reg({
    name: 'echo', category: 'text', summary: 'вывести текст', usage: 'echo [-n] [-e] TEXT...',
    run: function (ctx) {
      var args = ctx.argv.slice();
      var noNl = false, esc = false;
      while (args.length && (args[0] === '-n' || args[0] === '-e' || args[0] === '-ne')) {
        if (args[0].indexOf('n') > 0) noNl = true;
        if (args[0].indexOf('e') > 0) esc = true;
        args.shift();
      }
      var text = args.join(' ');
      if (esc) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      ctx.out(text + (noNl ? '' : '\n'));
      return 0;
    }
  });

  reg({
    name: 'printf', category: 'text', summary: 'форматированный вывод', usage: 'printf FORMAT [ARG...]',
    run: function (ctx) {
      var fmt = ctx.argv[0] || '';
      var args = ctx.argv.slice(1);
      var i = 0;
      var out = fmt.replace(/%[-0-9.]*[sdif%]/g, function (m) {
        if (m === '%%') return '%';
        var v = args[i++];
        if (/[dif]$/.test(m)) return String(Number(v) || 0);
        return v === undefined ? '' : v;
      }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      ctx.out(out);
      return 0;
    }
  });

  reg({
    name: 'grep', aliases: ['egrep', 'fgrep'], category: 'text', summary: 'поиск по шаблону',
    usage: 'grep [-i] [-v] [-n] [-c] [-r] [-E] [-w] PATTERN [FILE...]',
    complete: function (ctx, word, argv, h) { return h.path(ctx, word); },
    run: function (ctx) {
      var p = A.parse(ctx.argv, {
        bool: ['i', 'v', 'n', 'c', 'r', 'R', 'E', 'w', 'q', 'o', 'l', 'H', 'a', 'F', 'color'],
        value: ['A', 'B', 'C', 'e', 'm']
      });
      var pattern = p.opts.e !== undefined ? p.opts.e : p.rest.shift();
      if (pattern === undefined) return ctx.usageError('Usage: grep [OPTION]... PATTERNS [FILE]...');
      var flags = p.flags.i ? 'i' : '';
      var src = pattern;
      if (p.flags.F || ctx.argv0 === 'fgrep') src = src.replace(/[.*+?^${}()|\[\]\\]/g, '\\$&');
      if (p.flags.w) src = '\\b(?:' + src + ')\\b';
      var re = C.regex(ctx, 'grep', src, flags);
      if (!re) return 2;

      var files = p.rest;
      var results = [];
      var showFile = files.length > 1 || p.flags.r || p.flags.R || p.flags.H;

      function scan(text, label) {
        lines(text).forEach(function (l, idx) {
          var hit = re.test(l);
          if (p.flags.v) hit = !hit;
          if (!hit) return;
          var prefix = showFile ? label + ':' : '';
          if (p.flags.n) prefix += (idx + 1) + ':';
          results.push(prefix + l);
        });
      }

      if ((p.flags.r || p.flags.R) && files.length) {
        files.forEach(function (base) {
          ctx.vfs.walkTree(ctx.resolve(base), ctx.fsctx, function (path, n) {
            if (n.type !== 'file') return;
            scan(ctx.vfs.contentOf(n), path);
          });
        });
      } else if (files.length) {
        var bad = false;
        files.forEach(function (f) {
          var data;
          try { data = ctx.vfs.read(ctx.resolve(f), ctx.fsctx); }
          catch (e) { ctx.errLine('grep: ' + f + ': ' + (e.message || 'No such file or directory')); bad = true; return; }
          scan(data, f);
        });
        if (bad && !results.length) return 2;
      } else {
        scan(ctx.stdin, '(standard input)');
      }

      if (p.flags.q) return results.length ? 0 : 1;
      if (p.flags.c) { ctx.line(String(results.length)); return results.length ? 0 : 1; }
      if (p.flags.l) {
        var seen = {};
        results.forEach(function (r) { seen[r.split(':')[0]] = 1; });
        Object.keys(seen).forEach(function (f) { ctx.line(f); });
        return results.length ? 0 : 1;
      }
      var limit = p.opts.m ? Number(p.opts.m) : results.length;
      results.slice(0, limit).forEach(function (r) { ctx.line(r); });
      return results.length ? 0 : 1;
    }
  });

  reg({
    name: 'wc', category: 'text', summary: 'подсчёт строк/слов/байт', usage: 'wc [-l] [-w] [-c] [FILE]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['l', 'w', 'c', 'm'] });
      var data = input(ctx, p.rest);
      if (data === null) return 1;
      var l = data === '' ? 0 : data.split('\n').length - (data.slice(-1) === '\n' ? 1 : 0);
      var w = data.trim() ? data.trim().split(/\s+/).length : 0;
      var c = data.length;
      var parts = [];
      if (p.flags.l) parts.push(l);
      if (p.flags.w) parts.push(w);
      if (p.flags.c || p.flags.m) parts.push(c);
      if (!parts.length) parts = [l, w, c];
      ctx.line(parts.map(function (x) { return U.pad(x, 6); }).join(' ') +
        (p.rest.length ? ' ' + p.rest[0] : ''));
      return 0;
    }
  });

  reg({
    name: 'sort', category: 'text', summary: 'сортировка строк', usage: 'sort [-n] [-r] [-u] [-k N] [-t SEP]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['n', 'r', 'u', 'h', 'f'], value: ['k', 't'] });
      var data = input(ctx, p.rest);
      if (data === null) return 1;
      var arr = lines(data);
      var sep = p.opts.t;
      var key = p.opts.k ? parseInt(p.opts.k, 10) : null;
      function val(s) {
        if (!key) return s;
        var parts = sep ? s.split(sep) : s.trim().split(/\s+/);
        return parts[key - 1] === undefined ? '' : parts[key - 1];
      }
      arr.sort(function (a, b) {
        var x = val(a), y = val(b);
        if (p.flags.n) { return (parseFloat(x) || 0) - (parseFloat(y) || 0); }
        if (p.flags.f) { x = x.toLowerCase(); y = y.toLowerCase(); }
        return x < y ? -1 : (x > y ? 1 : 0);
      });
      if (p.flags.r) arr.reverse();
      if (p.flags.u) {
        var seen = {}, out = [];
        arr.forEach(function (l) { if (!seen[l]) { seen[l] = 1; out.push(l); } });
        arr = out;
      }
      ctx.out(arr.join('\n') + (arr.length ? '\n' : ''));
      return 0;
    }
  });

  reg({
    name: 'uniq', category: 'text', summary: 'убрать повторы соседних строк', usage: 'uniq [-c] [-d] [-u]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['c', 'd', 'u', 'i'] });
      var data = input(ctx, p.rest);
      if (data === null) return 1;
      var arr = lines(data);
      var out = [];
      var i = 0;
      while (i < arr.length) {
        var count = 1;
        while (i + count < arr.length &&
          (p.flags.i ? arr[i + count].toLowerCase() === arr[i].toLowerCase() : arr[i + count] === arr[i])) count++;
        if (p.flags.d && count === 1) { i += count; continue; }
        if (p.flags.u && count > 1) { i += count; continue; }
        out.push(p.flags.c ? U.pad(count, 7) + ' ' + arr[i] : arr[i]);
        i += count;
      }
      ctx.out(out.join('\n') + (out.length ? '\n' : ''));
      return 0;
    }
  });

  reg({
    name: 'cut', category: 'text', summary: 'вырезать поля/символы', usage: 'cut -d SEP -f LIST | -c LIST',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { value: ['d', 'f', 'c'], bool: ['s'] });
      var data = input(ctx, p.rest);
      if (data === null) return 1;
      var d = p.opts.d === undefined ? '\t' : p.opts.d;
      var fields = (p.opts.f || p.opts.c || '').split(',').map(function (f) {
        if (f.indexOf('-') > 0) {
          var r = f.split('-');
          return { from: Number(r[0]), to: r[1] ? Number(r[1]) : 9999 };
        }
        return { from: Number(f), to: Number(f) };
      });
      lines(data).forEach(function (l) {
        if (p.opts.c) {
          var outc = '';
          fields.forEach(function (f) { outc += l.slice(f.from - 1, f.to); });
          ctx.line(outc);
          return;
        }
        if (p.flags.s && l.indexOf(d) < 0) return;
        var parts = l.split(d);
        var sel = [];
        fields.forEach(function (f) {
          for (var i = f.from; i <= Math.min(f.to, parts.length); i++) {
            if (parts[i - 1] !== undefined) sel.push(parts[i - 1]);
          }
        });
        ctx.line(sel.join(d));
      });
      return 0;
    }
  });

  reg({
    name: 'tr', category: 'text', summary: 'замена символов', usage: 'tr [-d] SET1 [SET2]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['d', 's'] });
      var set1 = p.rest[0] || '', set2 = p.rest[1] || '';
      function expandSet(s) {
        return s.replace(/a-z/g, 'abcdefghijklmnopqrstuvwxyz')
          .replace(/A-Z/g, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
          .replace(/0-9/g, '0123456789');
      }
      var a = expandSet(set1), b = expandSet(set2);
      var out = String(ctx.stdin).split('').map(function (ch) {
        var i = a.indexOf(ch);
        if (i < 0) return ch;
        if (p.flags.d) return '';
        return b[Math.min(i, b.length - 1)] || '';
      }).join('');
      if (p.flags.s) out = out.replace(/(.)\1+/g, '$1');
      ctx.out(out);
      return 0;
    }
  });

  reg({
    name: 'nl', category: 'text', summary: 'нумерация строк', usage: 'nl [FILE]',
    run: function (ctx) {
      var data = input(ctx, ctx.argv.filter(function (a) { return a[0] !== '-'; }));
      if (data === null) return 1;
      var n = 1;
      lines(data).forEach(function (l) {
        ctx.line(l.trim() ? U.pad(n++, 6) + '\t' + l : '');
      });
      return 0;
    }
  });

  reg({
    name: 'tee', category: 'text', summary: 'вывод в файл и на экран', usage: 'tee [-a] FILE',
    complete: function (ctx, word, argv, h) { return h.path(ctx, word); },
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['a'] });
      var data = ctx.stdin;
      p.rest.forEach(function (f) {
        try { ctx.vfs.write(ctx.resolve(f), data, ctx.fsctx, { append: p.flags.a }); }
        catch (e) { ctx.errLine('tee: ' + f + ': ' + (e.message || 'Permission denied')); }
      });
      ctx.out(data);
      return 0;
    }
  });

  reg({
    name: 'xargs', category: 'text', summary: 'подставить stdin как аргументы', usage: 'xargs [-n N] COMMAND',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { value: ['n', 'I'] });
      var args = p.rest.length ? p.rest : ['echo'];
      var items = String(ctx.stdin).trim().split(/\s+/).filter(Boolean);
      if (!items.length) return 0;
      var chunks = [];
      var n = p.opts.n ? Number(p.opts.n) : items.length;
      for (var i = 0; i < items.length; i += n) chunks.push(items.slice(i, i + n));
      var idx = 0;
      function step() {
        if (idx >= chunks.length) return 0;
        var argv = args.concat(chunks[idx++]);
        if (p.opts.I) {
          argv = args.map(function (a) { return a === p.opts.I ? chunks[idx - 1][0] : a; });
        }
        return NET.shell.invokeAs(ctx, argv, ctx.user).then(step);
      }
      return step();
    }
  });

  /* ---------- awk (рабочее подмножество) ---------- */

  reg({
    name: 'awk', category: 'text', summary: 'обработка по столбцам',
    usage: "awk [-F sep] '{print $1}' [FILE]",
    run: function (ctx) {
      var p = A.parse(ctx.argv, { value: ['F', 'v'] });
      var program = p.rest.shift();
      if (!program) return ctx.usageError('usage: awk [-F fs] \'prog\' [file ...]');
      var data = input(ctx, p.rest);
      if (data === null) return 1;
      var FS = p.opts.F;
      if (FS === undefined) FS = null;
      else if (FS === '\\t') FS = '\t';

      var blocks = parseProgram(program);
      var vars = { NR: 0, NF: 0, FS: FS || ' ', OFS: ' ' };
      var rows = lines(data);

      blocks.filter(function (b) { return b.type === 'BEGIN'; }).forEach(function (b) {
        runActions(b.action, [], vars, ctx);
      });

      rows.forEach(function (line) {
        vars.NR++;
        var fields = FS === null ? line.trim().split(/\s+/) : line.split(FS);
        if (line.trim() === '' && FS === null) fields = [];
        vars.NF = fields.length;
        vars.$0 = line;
        blocks.forEach(function (b) {
          if (b.type !== 'rule') return;
          if (b.pattern && !matchPattern(b.pattern, line, fields, vars)) return;
          if (!b.action) { ctx.line(line); return; }
          runActions(b.action, fields, vars, ctx);
        });
      });

      blocks.filter(function (b) { return b.type === 'END'; }).forEach(function (b) {
        runActions(b.action, [], vars, ctx);
      });
      return 0;
    }
  });

  function parseProgram(src) {
    var blocks = [];
    var i = 0;
    while (i < src.length) {
      while (i < src.length && /\s|;/.test(src[i])) i++;
      if (i >= src.length) break;
      var type = 'rule', pattern = null;
      if (src.slice(i, i + 5) === 'BEGIN') { type = 'BEGIN'; i += 5; }
      else if (src.slice(i, i + 3) === 'END') { type = 'END'; i += 3; }
      else {
        var start = i;
        while (i < src.length && src[i] !== '{') i++;
        pattern = src.slice(start, i).trim() || null;
      }
      while (i < src.length && /\s/.test(src[i])) i++;
      var action = null;
      if (src[i] === '{') {
        var depth = 1, s = ++i;
        while (i < src.length && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') { depth--; if (!depth) break; }
          i++;
        }
        action = src.slice(s, i);
        i++;
      }
      blocks.push({ type: type, pattern: pattern, action: action });
    }
    return blocks;
  }

  function matchPattern(pattern, line, fields, vars) {
    pattern = pattern.trim();
    if (/^\/.*\/$/.test(pattern)) {
      var compiled = U.safeRegExp(pattern.slice(1, -1));
      return compiled.re ? compiled.re.test(line) : false;
    }
    var m = pattern.match(/^(.+?)\s*(==|!=|>=|<=|>|<|~|!~)\s*(.+)$/);
    if (m) {
      var left = evalExpr(m[1], fields, vars);
      var right = m[3].trim();
      if (/^\/.*\/$/.test(right)) {
        var rx = U.safeRegExp(right.slice(1, -1));
        if (!rx.re) return false;
        return m[2] === '~' ? rx.re.test(left) : !rx.re.test(left);
      }
      var r = evalExpr(right, fields, vars);
      var ln = parseFloat(left), rn = parseFloat(r);
      var numeric = !isNaN(ln) && !isNaN(rn);
      switch (m[2]) {
        case '==': return numeric ? ln === rn : String(left) === String(r);
        case '!=': return numeric ? ln !== rn : String(left) !== String(r);
        case '>': return numeric ? ln > rn : left > r;
        case '<': return numeric ? ln < rn : left < r;
        case '>=': return numeric ? ln >= rn : left >= r;
        case '<=': return numeric ? ln <= rn : left <= r;
      }
    }
    var v = evalExpr(pattern, fields, vars);
    return !!v && v !== '0';
  }

  function evalExpr(expr, fields, vars) {
    expr = String(expr).trim();
    if (/^".*"$/.test(expr)) return expr.slice(1, -1);
    if (/^\$NF$/.test(expr)) return fields[fields.length - 1] || '';
    var fm = expr.match(/^\$\(?(\d+)\)?$/);
    if (fm) {
      var n = Number(fm[1]);
      return n === 0 ? (vars.$0 || '') : (fields[n - 1] === undefined ? '' : fields[n - 1]);
    }
    if (expr === 'NR') return vars.NR;
    if (expr === 'NF') return vars.NF;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    if (vars[expr] !== undefined) return vars[expr];
    /* простая арифметика и конкатенация */
    var parts = expr.split(/\s*\+\s*/);
    if (parts.length > 1) {
      return parts.reduce(function (acc, p) { return acc + (parseFloat(evalExpr(p, fields, vars)) || 0); }, 0);
    }
    return expr;
  }

  function runActions(action, fields, vars, ctx) {
    if (!action) return;
    action.split(/;|\n/).forEach(function (stmt) {
      stmt = stmt.trim();
      if (!stmt) return;
      var pm = stmt.match(/^print\s*(.*)$/);
      if (pm) {
        var argsRaw = pm[1].trim();
        if (!argsRaw) { ctx.line(vars.$0 || fields.join(' ')); return; }
        var parts = splitArgs(argsRaw);
        var out = parts.map(function (a) { return evalExpr(a, fields, vars); });
        ctx.line(out.join(vars.OFS));
        return;
      }
      var am = stmt.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(\+?)=\s*(.+)$/);
      if (am) {
        var val = evalExpr(am[3], fields, vars);
        if (am[2] === '+') vars[am[1]] = (parseFloat(vars[am[1]]) || 0) + (parseFloat(val) || 0);
        else vars[am[1]] = val;
      }
    });
  }

  function splitArgs(s) {
    var out = [], cur = '', inStr = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '"') { inStr = !inStr; cur += c; continue; }
      if (c === ',' && !inStr) { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  /* ---------- sed ---------- */

  reg({
    name: 'sed', category: 'text', summary: 'потоковое редактирование',
    usage: "sed [-n] [-i] 'SCRIPT' [FILE]",
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['n', 'i', 'r', 'E'], value: ['e'] });
      var script = p.opts.e !== undefined ? p.opts.e : p.rest.shift();
      if (!script) return ctx.usageError('usage: sed [-n] script [file]');
      var file = p.rest[0];
      var data = file ? null : ctx.stdin;
      if (file) {
        try { data = ctx.vfs.read(ctx.resolve(file), ctx.fsctx); }
        catch (e) { return ctx.fail("sed: can't read " + file + ': No such file or directory', 2); }
      }
      var arr = lines(data);
      var out = [];

      var sm = script.match(/^s(.)(.*?)\1(.*?)\1([gip]*)$/);
      if (sm) {
        var reFlags = (sm[4].indexOf('g') >= 0 ? 'g' : '') + (sm[4].indexOf('i') >= 0 ? 'i' : '');
        var re = C.regex(ctx, 'sed', sm[2], reFlags);
        if (!re) return 1;
        arr.forEach(function (l) { out.push(l.replace(re, sm[3])); });
      } else if (/^\/(.*)\/d$/.test(script)) {
        var dre = C.regex(ctx, 'sed', script.match(/^\/(.*)\/d$/)[1]);
        if (!dre) return 1;
        arr.forEach(function (l) { if (!dre.test(l)) out.push(l); });
      } else if (/^(\d+)(,(\d+|\$))?p$/.test(script)) {
        var m = script.match(/^(\d+)(,(\d+|\$))?p$/);
        var from = Number(m[1]);
        var to = m[3] === '$' ? arr.length : (m[3] ? Number(m[3]) : from);
        arr.forEach(function (l, i) { if (i + 1 >= from && i + 1 <= to) out.push(l); });
        if (!p.flags.n) { out = arr; }
      } else if (/^(\d+)d$/.test(script)) {
        var dn = Number(script.match(/^(\d+)d$/)[1]);
        arr.forEach(function (l, i) { if (i + 1 !== dn) out.push(l); });
      } else {
        return ctx.fail('sed: -e expression #1, char 1: unknown command: `' + script[0] + "'", 1);
      }

      if (p.flags.i && file) {
        try {
          ctx.vfs.write(ctx.resolve(file), out.join('\n') + '\n', ctx.fsctx);
        } catch (e) { return ctx.fail("sed: couldn't open file " + file + ': Permission denied', 4); }
        return 0;
      }
      if (p.flags.n && !sm) ctx.out(out.join('\n') + (out.length ? '\n' : ''));
      else ctx.out(out.join('\n') + (out.length ? '\n' : ''));
      return 0;
    }
  });

  reg({
    name: 'diff', category: 'text', summary: 'сравнить файлы', usage: 'diff FILE1 FILE2',
    complete: function (ctx, word, argv, h) { return h.path(ctx, word); },
    run: function (ctx) {
      if (ctx.argv.length < 2) return ctx.usageError('diff: missing operand');
      var a, b;
      try {
        a = lines(ctx.vfs.read(ctx.resolve(ctx.argv[0]), ctx.fsctx));
        b = lines(ctx.vfs.read(ctx.resolve(ctx.argv[1]), ctx.fsctx));
      } catch (e) { return ctx.fail('diff: ' + (e.path || '') + ': No such file or directory', 2); }
      var diffs = 0;
      var max = Math.max(a.length, b.length);
      for (var i = 0; i < max; i++) {
        if (a[i] !== b[i]) {
          diffs++;
          ctx.line((i + 1) + 'c' + (i + 1));
          if (a[i] !== undefined) ctx.line('< ' + a[i]);
          ctx.line('---');
          if (b[i] !== undefined) ctx.line('> ' + b[i]);
        }
      }
      return diffs ? 1 : 0;
    }
  });
})(window.NET);
