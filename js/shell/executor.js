/*
 * executor.js — исполнение разобранной строки.
 *
 * Поддержаны пайплайны, редиректы, && || ;, подстановка $( ), присваивания
 * переменных, exit codes и переключение пользователя (sudo/su). Команды —
 * async-функции, поэтому ping может печатать строки с реалистичной задержкой,
 * а curl — «висеть» до таймаута.
 */
(function (NET) {
  'use strict';

  var U = NET.util;

  function Session(world, opts) {
    opts = opts || {};
    this.world = world;
    this.hosts = {};
    this.lastExit = 0;
    this.shellPid = U.randInt(2000, 9000);
    this.history = new NET.History(this);
    this.streaming = true;
    this.depth = 0;
    this.onOutput = opts.onOutput || function () {};
    this.onError = opts.onError || null;
    this.aborted = false;
    this.onPager = opts.onPager || null;
    this.onClear = opts.onClear || function () {};
    this.aliases = { ll: 'ls -alF', la: 'ls -A', l: 'ls -CF' };
    var self = this;
    world.each(function (m) {
      if (!m.shell) return;
      var u = m.mainUser;
      self.hosts[m.name] = {
        user: u,
        cwd: '/home/' + u,
        env: {
          HOME: '/home/' + u, USER: u, LOGNAME: u, SHELL: '/bin/bash',
          PATH: m.env.PATH, PWD: '/home/' + u, LANG: 'en_US.UTF-8',
          TERM: 'xterm-256color', HOSTNAME: m.hostname, OLDPWD: '/home/' + u
        }
      };
    });
  }

  Session.prototype.machine = function () { return this.world.machine(); };

  Session.prototype.state = function (machine) {
    var m = machine || this.machine();
    if (!this.hosts[m.name]) {
      this.hosts[m.name] = {
        user: m.mainUser, cwd: '/home/' + m.mainUser,
        env: { HOME: '/home/' + m.mainUser, USER: m.mainUser, PATH: m.env.PATH, PWD: '/home/' + m.mainUser }
      };
    }
    return this.hosts[m.name];
  };

  Session.prototype.user = function () { return this.state().user; };
  Session.prototype.cwd = function () { return this.state().cwd; };
  Session.prototype.isRoot = function () { return this.state().user === 'root'; };

  Session.prototype.setUser = function (name) {
    var st = this.state();
    st.user = name;
    var u = this.machine().users.byName(name);
    st.env.HOME = u ? u.home : '/root';
    st.env.USER = name;
    st.env.LOGNAME = name;
    NET.bus.emit('shell:user-changed', { user: name });
  };

  Session.prototype.prompt = function () {
    var m = this.machine();
    var st = this.state();
    var cwd = st.cwd;
    var home = st.env.HOME;
    var short = cwd === home ? '~' : (home && cwd.indexOf(home + '/') === 0 ? '~' + cwd.slice(home.length) : cwd);
    return {
      user: st.user, host: m.hostname, cwd: short,
      sign: st.user === 'root' ? '#' : '$',
      text: st.user + '@' + m.hostname + ':' + short + (st.user === 'root' ? '# ' : '$ ')
    };
  };

  Session.prototype.write = function (text) { this.onOutput(text); };

  /* stderr печатается отдельным каналом — терминал подсвечивает его иначе */
  Session.prototype.writeErr = function (text) {
    (this.onError || this.onOutput)(text);
  };

  /* ---------- контекст выполнения команды ---------- */

  function makeCtx(session, opts) {
    opts = opts || {};
    var machine = opts.machine || session.machine();
    var st = session.state(machine);
    var user = opts.user || st.user;
    var fsctx = machine.users.ctx(user);
    var ctx = {
      session: session,
      world: session.world,
      machine: machine,
      vfs: machine.vfs,
      net: machine.net,
      argv: [],
      argv0: '',
      stdin: opts.stdin === undefined ? '' : opts.stdin,
      env: st.env,
      cwd: st.cwd,
      user: user,
      uid: fsctx.uid,
      fsctx: fsctx,
      isRoot: fsctx.uid === 0,
      streaming: !!opts.streaming && session.streaming,
      _out: [],
      _err: [],
      sink: opts.sink || null,
      exitCode: 0
    };
    ctx._written = 0;
    ctx._truncated = false;
    /*
     * Вывод одной команды ограничен: `find /` или цикл в скрипте не должны
     * набить в DOM сотни тысяч строк и подвесить рендеринг.
     */
    ctx.out = function (text) {
      if (text === undefined || text === null) return;
      var s = String(text);
      if (ctx._truncated) return;
      ctx._written += s.length;
      if (ctx._written > U.LIMITS.outputChars) {
        ctx._truncated = true;
        s = s.slice(0, Math.max(0, U.LIMITS.outputChars - (ctx._written - s.length))) +
          '\n[вывод обрезан: превышен предел ' + U.LIMITS.outputChars + ' символов]\n';
      }
      if (ctx.sink) ctx.sink(s);
      else ctx._out.push(s);
    };
    ctx.line = function (text) { ctx.out((text === undefined ? '' : text) + '\n'); };
    ctx.err = function (text) {
      var s = String(text);
      if (ctx.errSink) ctx.errSink(s);
      else ctx._err.push(s);
    };
    ctx.errLine = function (text) { ctx.err((text === undefined ? '' : text) + '\n'); };
    ctx.fail = function (msg, code) {
      ctx.errLine(msg);
      return code === undefined ? 1 : code;
    };
    ctx.usageError = function (msg) {
      ctx.errLine(msg);
      return 2;
    };
    ctx.aborted = function () { return !!session.aborted; };
    ctx.sleep = function (ms) {
      if (!ctx.streaming || !ms || session.aborted) return Promise.resolve();
      return U.sleep(Math.min(ms, 1500));
    };
    ctx.resolve = function (p) { return machine.vfs.normalize(p, ctx.cwd); };
    ctx.requireRoot = function (name) {
      if (ctx.isRoot) return null;
      return name + ': Operation not permitted (are you root?)';
    };
    return ctx;
  }

  /* ---------- вспомогательные функции ---------- */

  function fsErrText(cmd, e, path) {
    if (e && e.name === 'FsError') {
      return cmd + ': ' + (path || e.path) + ': ' + e.message;
    }
    return cmd + ': ' + (e && e.message ? e.message : String(e));
  }

  /* ---------- запуск ---------- */

  function runLine(session, line, opts) {
    opts = opts || {};
    if (session.depth > 8) return Promise.resolve(1);

    /* Защита от гигантского ввода: браузер не должен получить строку,
       разбор и вывод которой подвесят вкладку (аналог E2BIG в exec). */
    if (String(line).length > U.LIMITS.cmdLine) {
      session.writeErr('bash: Argument list too long (ограничение тренажёра: ' +
        U.LIMITS.cmdLine + ' символов)\n');
      session.lastExit = 126;
      return Promise.resolve(126);
    }

    var lex = NET.lexer.tokenize(line);
    if (lex.error) {
      session.write('bash: ' + lex.error + '\n');
      session.lastExit = 2;
      return Promise.resolve(2);
    }
    var parsed = NET.parser.parse(lex.tokens);
    if (parsed.error) {
      session.write('bash: ' + parsed.error + '\n');
      session.lastExit = 2;
      return Promise.resolve(2);
    }
    var list = parsed.list;
    var idx = 0;
    var lastCode = session.lastExit;

    function step() {
      if (idx >= list.length) {
        session.lastExit = lastCode;
        return Promise.resolve(lastCode);
      }
      var item = list[idx];
      var prevOp = idx > 0 ? list[idx - 1].op : null;
      if (prevOp === '&&' && lastCode !== 0) { idx++; return step(); }
      if (prevOp === '||' && lastCode === 0) { idx++; return step(); }
      return execPipeline(session, item.pipeline, opts).then(function (code) {
        lastCode = code;
        session.lastExit = code;
        idx++;
        return step();
      });
    }
    return step();
  }

  function execPipeline(session, pipeline, opts) {
    var cmds = pipeline.commands;
    if (cmds.length > U.LIMITS.pipeStages) {
      session.writeErr('bash: слишком длинный конвейер (не больше ' +
        U.LIMITS.pipeStages + ' команд)\n');
      session.lastExit = 2;
      return Promise.resolve(2);
    }
    var stdin = opts.stdin || '';
    var i = 0;

    function runNext() {
      if (i >= cmds.length) return Promise.resolve(session.lastExit);
      var node = cmds[i];
      var isLast = (i === cmds.length - 1);
      var ctx = makeCtx(session, { stdin: stdin, streaming: isLast && !opts.capture });

      var runSub = function (sub) {
        session.depth++;
        return captureLine(session, sub, { passErr: true }).then(function (res) {
          session.depth--;
          return res.stdout;
        });
      };

      return NET.expand.expandWords(node.words, ctx, runSub).then(function (argv) {
        /* присваивания переменных перед командой */
        var assigns = [];
        while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) {
          assigns.push(argv.shift());
        }
        /* VAR=значение: имена вроде __proto__ игнорируем, чтобы присваивание
           не меняло прототип объекта окружения */
        function applyAssign(a) {
          var eq = a.indexOf('=');
          var name = a.slice(0, eq);
          if (NET.schema.isUnsafeKey(name)) {
            ctx.errLine('bash: ' + name + ': недопустимое имя переменной');
            return;
          }
          ctx.env[name] = a.slice(eq + 1);
        }
        if (!argv.length) {
          assigns.forEach(applyAssign);
          return 0;
        }
        assigns.forEach(applyAssign);

        /* алиасы */
        var alias = session.aliases[argv[0]];
        if (alias && !opts.noAlias) {
          var re = NET.lexer.tokenize(alias);
          var extra = [];
          (re.tokens || []).forEach(function (t) {
            if (t.type === 'word') extra.push(t.parts.map(function (p) { return p.text; }).join(''));
          });
          argv = extra.concat(argv.slice(1));
        }

        ctx.argv = argv.slice(1);
        ctx.argv0 = argv[0];
        ctx.rawArgv = argv;

        /* редиректы */
        var outFile = null, outAppend = false, errFile = null, errAppend = false, dupErr = false;
        var redirErr = null;
        node.redirects.forEach(function (r) {
          if (r.type === 'dup') { dupErr = true; return; }
          var target;
          if (r.target) {
            target = r.target.parts.map(function (p) { return p.text; }).join('');
            target = NET.expand.substVars(target, ctx);
          }
          if (r.type === 'in') {
            try {
              ctx.stdin = ctx.vfs.read(ctx.resolve(target), ctx.fsctx);
            } catch (e) { redirErr = 'bash: ' + target + ': No such file or directory'; }
          } else if (r.fd === 1 || r.fd === 3) {
            outFile = target; outAppend = r.append;
            if (r.fd === 3) { errFile = target; errAppend = r.append; }
          } else if (r.fd === 2) {
            errFile = target; errAppend = r.append;
          }
        });
        if (redirErr) { session.write(redirErr + '\n'); return 1; }

        var collectedOut = '';
        var collectedErr = '';
        var streamOut = isLast && !outFile && !opts.capture;
        ctx.streaming = streamOut && session.streaming;
        ctx.sink = streamOut ? function (s) { session.write(s); } : function (s) { collectedOut += s; };
        /* При подстановке $( ) захватывается только stdout: диагностика
           вложенной команды идёт в терминал, как это делает bash. */
        var errToTerminal = (isLast && !errFile && !opts.capture) || (opts.capture && opts.passErr && !errFile);
        ctx.errSink = errToTerminal
          ? function (s) { if (dupErr && outFile) collectedOut += s; else session.writeErr(s); }
          : function (s) { collectedErr += s; };
        if (dupErr && !errFile) ctx.errSink = ctx.sink;

        var cmd = NET.commands.get(argv[0]);
        var exec = null;
        if (!cmd) {
          /* запуск скрипта по пути */
          if (/^[.\/]/.test(argv[0])) {
            var p = ctx.resolve(argv[0]);
            var node2 = ctx.vfs.get(p, ctx.fsctx);
            if (!node2) { ctx.errLine('bash: ' + argv[0] + ': No such file or directory'); return finish(127); }
            if (!ctx.vfs.can(node2, ctx.fsctx, 'x')) { ctx.errLine('bash: ' + argv[0] + ': Permission denied'); return finish(126); }
            exec = runScript(session, ctx, p);
          } else {
            ctx.errLine('bash: ' + argv[0] + ': command not found');
            return finish(127);
          }
        }

        NET.bus.emit('shell:exec', {
          machine: ctx.machine.name, user: ctx.user, argv: argv.slice(),
          line: argv.join(' '), cwd: ctx.cwd
        });

        var promise;
        try {
          promise = exec ? exec : Promise.resolve(cmd.run(ctx));
        } catch (e) {
          if (e && e.name === 'FsError') {
            ctx.errLine(fsErrText(argv[0], e));
            promise = Promise.resolve(1);
          } else {
            console.error(e);
            ctx.errLine(argv[0] + ': internal error: ' + (e && e.message));
            promise = Promise.resolve(1);
          }
        }

        return Promise.resolve(promise).then(function (code) {
          return finish(code === undefined ? 0 : code);
        }, function (e) {
          if (e && e.name === 'FsError') ctx.errLine(fsErrText(argv[0], e));
          else { console.error(e); ctx.errLine(argv[0] + ': ' + (e && e.message ? e.message : 'error')); }
          return finish(1);
        });

        function finish(code) {
          /* записываем перенаправленный вывод в файлы */
          if (outFile) {
            try {
              ctx.vfs.write(ctx.resolve(outFile), collectedOut, ctx.fsctx, { append: outAppend });
            } catch (e) {
              session.write('bash: ' + outFile + ': ' + (e.message || 'cannot write') + '\n');
              code = 1;
            }
          }
          if (errFile && !(dupErr && outFile)) {
            try {
              ctx.vfs.write(ctx.resolve(errFile), collectedErr, ctx.fsctx, { append: errAppend });
            } catch (e) { session.write('bash: ' + errFile + ': cannot write\n'); }
          }
          session.lastExit = code;
          stdin = outFile ? '' : collectedOut;
          if (opts.capture && isLast) opts._captured = collectedOut;
          if (opts.capture && isLast) opts._capturedErr = collectedErr;
          i++;
          if (i < cmds.length) return runNext();
          return code;
        }
      });
    }

    return runNext();
  }

  /* Запуск shell-скрипта: последовательное выполнение строк. */
  function runScript(session, ctx, path) {
    var text;
    try { text = ctx.vfs.read(path, ctx.fsctx); } catch (e) { return Promise.resolve(1); }
    var lines = text.split('\n').filter(function (l) { return l.trim() && !/^\s*#/.test(l); });
    var idx = 0, code = 0;
    function step() {
      if (idx >= lines.length) return Promise.resolve(code);
      var l = lines[idx++];
      session.depth++;
      return runLine(session, l, {}).then(function (c) {
        session.depth--;
        code = c;
        return step();
      });
    }
    return step();
  }

  /* Выполнить строку и вернуть её вывод (для $( ) и внутренних проверок). */
  function captureLine(session, line, extra) {
    var opts = { capture: true };
    if (extra && extra.passErr) opts.passErr = true;
    var savedExit = session.lastExit;
    return runLine(session, line, opts).then(function (code) {
      return { stdout: opts._captured || '', stderr: opts._capturedErr || '', code: code };
    });
  }

  /* Выполнить команду от другого пользователя (sudo/su). */
  function invokeAs(ctx, argv, user) {
    var cmd = NET.commands.get(argv[0]);
    if (!cmd) {
      ctx.errLine('sudo: ' + argv[0] + ': command not found');
      return Promise.resolve(127);
    }
    var sub = makeCtx(ctx.session, {
      machine: ctx.machine, user: user, stdin: ctx.stdin, streaming: ctx.streaming
    });
    sub.sink = ctx.sink;
    sub.errSink = ctx.errSink;
    sub.argv = argv.slice(1);
    sub.argv0 = argv[0];
    sub.rawArgv = argv;
    sub.cwd = ctx.cwd;
    NET.bus.emit('shell:exec', {
      machine: ctx.machine.name, user: user, argv: argv.slice(),
      line: argv.join(' '), cwd: ctx.cwd, viaSudo: true
    });
    try {
      return Promise.resolve(cmd.run(sub)).then(function (c) { return c === undefined ? 0 : c; });
    } catch (e) {
      if (e && e.name === 'FsError') { ctx.errLine(fsErrText(argv[0], e)); return Promise.resolve(1); }
      console.error(e);
      ctx.errLine(argv[0] + ': ' + (e && e.message));
      return Promise.resolve(1);
    }
  }

  NET.shell = {
    Session: Session,
    createSession: function (world, opts) { return new Session(world, opts); },
    run: runLine,
    capture: captureLine,
    makeCtx: makeCtx,
    invokeAs: invokeAs,
    fsErrText: fsErrText
  };
})(window.NET);
