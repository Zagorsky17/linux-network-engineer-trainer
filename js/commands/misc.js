/*
 * misc.js — служебные команды: man, help, clear, history, connect и мостик
 * к лабораториям (lab/hint/check/reset), чтобы не снимать руки с клавиатуры.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;

  reg({
    name: 'man', category: 'help', summary: 'справка по команде', usage: 'man COMMAND',
    complete: function (ctx, word) {
      return NET.man.names().filter(function (n) { return n.indexOf(word) === 0; });
    },
    run: function (ctx) {
      var name = ctx.argv[ctx.argv.length - 1];
      if (!name) { ctx.errLine('What manual page do you want?'); return 1; }
      var page = NET.man.get(name);
      if (!page) {
        var cmd = NET.commands.get(name);
        if (cmd) {
          ctx.line(name.toUpperCase() + '(1)');
          ctx.line('');
          ctx.line('NAME');
          ctx.line('       ' + name + ' - ' + (cmd.summary || ''));
          ctx.line('');
          ctx.line('SYNOPSIS');
          ctx.line('       ' + (cmd.usage || name));
          ctx.line('');
          return 0;
        }
        ctx.errLine('No manual entry for ' + name);
        return 16;
      }
      if (ctx.session.onPager && ctx.streaming) {
        ctx.session.onPager(page.body, 'man ' + name);
        return 0;
      }
      ctx.out(page.body);
      return 0;
    }
  });

  reg({
    name: 'help', category: 'help', summary: 'список доступных команд', usage: 'help [CATEGORY]',
    run: function (ctx) {
      var cats = NET.commands.byCategory();
      var titles = {
        fs: 'Файловая система', text: 'Текст и пайплайны', sys: 'Система, права, процессы',
        net: 'Сеть и диагностика', dns: 'DNS', netcfg: 'Конфигурация сети',
        firewall: 'Firewall', capture: 'Анализ трафика', services: 'Сервисы и пакеты',
        help: 'Справка', trainer: 'Тренажёр'
      };
      var filter = ctx.argv[0];
      Object.keys(cats).forEach(function (c) {
        if (filter && c !== filter) return;
        ctx.line('');
        ctx.line('== ' + (titles[c] || c) + ' ==');
        var names = cats[c].map(function (cmd) { return cmd.name; });
        ctx.line(U.columns(names, 76));
      });
      ctx.line('');
      ctx.line('man <команда> — подробности. help <категория> — только раздел.');
      ctx.line('Категории: ' + Object.keys(cats).join(', '));
      return 0;
    }
  });

  reg({
    name: 'clear', category: 'help', summary: 'очистить терминал', usage: 'clear',
    run: function (ctx) {
      if (ctx.streaming) ctx.session.onClear();
      return 0;
    }
  });

  reg({
    name: 'history', category: 'help', summary: 'история команд', usage: 'history [-c]',
    run: function (ctx) {
      var h = ctx.session.history;
      if (ctx.argv[0] === '-c') { h.clear(); return 0; }
      h.items.forEach(function (line, i) {
        ctx.line(U.pad(i + 1, 5) + '  ' + line);
      });
      return 0;
    }
  });

  reg({
    name: 'connect', category: 'trainer', summary: 'переключиться на другой виртуальный хост',
    usage: 'connect [HOST]',
    complete: function (ctx, word, argv, h) { return h.hosts(ctx); },
    run: function (ctx) {
      var name = ctx.argv[0];
      if (!name) {
        ctx.line('Доступные хосты с консолью:');
        ctx.world.shells().forEach(function (m) {
          var ip = m.net.primaryIP() || '—';
          ctx.line('  ' + U.padRight(m.name, 12) + U.padRight(m.hostname, 14) + U.padRight(ip, 16) +
            (m.name === ctx.world.current ? '<- текущий' : ''));
        });
        return 0;
      }
      var target = ctx.world.get(name);
      if (!target) return ctx.fail('connect: неизвестный хост: ' + name);
      if (!target.shell) return ctx.fail('connect: у хоста ' + name + ' нет консоли (это инфраструктурный узел)');
      ctx.world.setCurrent(name);
      ctx.line('Переключено на ' + target.hostname + ' (' + (target.net.primaryIP() || 'без адреса') + ')');
      return 0;
    }
  });

  reg({
    name: 'hosts', category: 'trainer', summary: 'список узлов топологии', usage: 'hosts',
    run: function (ctx) {
      ctx.line(U.padRight('NODE', 12) + U.padRight('HOSTNAME', 16) + U.padRight('ROLE', 10) +
        U.padRight('ADDRESSES', 30) + 'SHELL');
      ctx.world.each(function (m) {
        var addrs = [];
        m.net.ifaces.forEach(function (i) {
          if (i.type === 'loopback') return;
          i.addrs.forEach(function (a) { if (a.family === 4) addrs.push(a.ip); });
        });
        ctx.line(U.padRight(m.name, 12) + U.padRight(m.hostname, 16) + U.padRight(m.kind, 10) +
          U.padRight(addrs.join(' ') || '—', 30) + (m.shell ? 'yes' : 'no'));
      });
      return 0;
    }
  });

  /* ---------- мостик к лабораториям ---------- */

  reg({
    name: 'lab', category: 'trainer', summary: 'лаборатории: список, старт, статус',
    usage: 'lab [list|start ID|status|reset|hint|check]',
    complete: function (ctx, word, argv) {
      if (argv.length <= 1) return ['list', 'start', 'status', 'reset', 'hint', 'check', 'solve'];
      return Object.keys(NET.registries.labs);
    },
    run: function (ctx) {
      var engine = NET.labs;
      if (!engine) return ctx.fail('lab: система лабораторий не загружена');
      var sub = ctx.argv[0] || 'status';
      if (sub === 'list') {
        engine.list().forEach(function (l) {
          var done = engine.isSolved(l.id) ? '✔' : ' ';
          ctx.line(done + ' ' + U.padRight(l.id, 8) + U.padRight('★'.repeat(l.difficulty), 7) + l.title);
        });
        return 0;
      }
      if (sub === 'start') {
        var id = ctx.argv[1];
        if (!id) return ctx.usageError('lab start <id>');
        if (!engine.get(id)) return ctx.fail('lab: нет лаборатории ' + id);
        var u = ui();
        if (u) { u.start(id); return 0; }
        var r = engine.start(id);
        if (r.err) return ctx.fail('lab: ' + r.err);
        ctx.line('Запущена лаборатория ' + id + ': ' + r.lab.title);
        ctx.line('');
        ctx.out(engine.briefText(r.lab) + '\n');
        return 0;
      }
      if (sub === 'status') {
        var cur = engine.current();
        if (!cur) { ctx.line('Активной лаборатории нет. lab list — список, lab start <id> — начать.'); return 0; }
        ctx.out(engine.briefText(cur.lab) + '\n');
        ctx.line('Выполнено шагов диагностики: ' + engine.progressText());
        return 0;
      }
      if (sub === 'reset') {
        var rr = engine.reset();
        ctx.line(rr.err ? rr.err : 'Лаборатория перезапущена в исходное состояние.');
        return rr.err ? 1 : 0;
      }
      if (sub === 'hint') return NET.shell.invokeAs(ctx, ['hint'], ctx.user);
      if (sub === 'check') return NET.shell.invokeAs(ctx, ['check'], ctx.user);
      return ctx.usageError('lab: неизвестная подкоманда ' + sub);
    }
  });

  /* Когда интерфейс загружен, команды тренажёра идут через его контроллер:
     так синхронно обновляются панели задания, разбора и прогресса. */
  function ui() { return NET.ui && NET.ui.labs ? NET.ui.labs : null; }

  reg({
    name: 'lesson', aliases: ['theory'], category: 'trainer',
    summary: 'теория: список уроков и чтение',
    usage: 'lesson [list | ID | lab01 | linux-basics]',
    complete: function (ctx, word, argv) {
      return ['list'].concat(NET.lessons ? NET.lessons.ids() : []);
    },
    run: function (ctx) {
      if (!NET.lessons) return ctx.fail('lesson: теория не загружена');
      var arg = ctx.argv[0];

      if (!arg || arg === 'list') {
        ctx.line('Теоретическая часть. Урок открывается командой: lesson <id>');
        ctx.line('');
        NET.lessons.list().forEach(function (l) {
          var read = NET.progress.isLessonRead(l.id) ? '✔' : ' ';
          ctx.line(' ' + read + ' ' + U.padRight(l.id, 14) +
            U.padRight('~' + l.minutes + ' мин', 9) + l.title);
        });
        ctx.line('');
        ctx.line('Начните с linux-basics, если раньше не работали в консоли Linux.');
        return 0;
      }

      var lesson = NET.lessons.get(arg) || NET.lessons.forLab(arg);
      if (!lesson) return ctx.fail('lesson: нет урока «' + arg + '» (см. lesson list)');

      /* В интерфейсе урок читается во вкладке «Теория» — там он свёрстан;
         в терминале печатаем краткое содержание, чтобы не терять контекст. */
      if (NET.ui && NET.ui.lesson && ctx.streaming) {
        NET.ui.lesson.show(lesson.id);
        ctx.line('Урок «' + lesson.title + '» открыт во вкладке «Теория» (Alt+3).');
        ctx.line('Время чтения: ~' + lesson.minutes + ' мин. Разделы:');
        lesson.sections.forEach(function (sec, i) { ctx.line('  ' + (i + 1) + '. ' + sec.h); });
        return 0;
      }

      ctx.line('── ' + lesson.title);
      ctx.line('');
      ctx.line(lesson.lead);
      lesson.sections.forEach(function (sec) {
        ctx.line('');
        ctx.line('## ' + sec.h);
        (sec.p || []).forEach(function (para) { ctx.line(para); });
        (sec.cmds || []).forEach(function (pair) {
          ctx.line('    ' + U.padRight(pair[0], 44) + (pair[1] || ''));
        });
        if (sec.note) ctx.line('    ! ' + sec.note);
      });
      if (lesson.summary) {
        ctx.line('');
        ctx.line('## Коротко');
        lesson.summary.forEach(function (t) { ctx.line('  · ' + t); });
      }
      return 0;
    }
  });

  reg({
    name: 'quiz', aliases: ['test-commands'], category: 'trainer',
    summary: 'тест по командам урока',
    usage: 'quiz [list | lab01 | linux-basics]',
    complete: function () {
      return ['list'].concat(NET.quiz ? NET.quiz.ids() : []);
    },
    run: function (ctx) {
      if (!NET.quiz) return ctx.fail('quiz: тесты не загружены');
      var arg = ctx.argv[0];

      if (!arg || arg === 'list') {
        ctx.line('Тесты по командам. Открыть тест: quiz <id>');
        ctx.line('');
        NET.quiz.ids().forEach(function (id) {
          var qz = NET.quiz.get(id);
          var res = NET.progress.quizResult(id);
          ctx.line('  ' + U.padRight(id, 14) + U.padRight(qz.questions.length + ' вопр.', 10) +
            U.padRight(res ? 'лучший ' + res.best + '%' : '—', 13) + qz.title);
        });
        ctx.line('');
        ctx.line('Зачёт — от ' + NET.quiz.PASS_PERCENT + '% верных ответов.');
        return 0;
      }

      var lesson = NET.lessons.get(arg) || NET.lessons.forLab(arg);
      var id = lesson ? lesson.id : arg;
      if (!NET.quiz.has(id)) return ctx.fail('quiz: нет теста «' + arg + '» (см. quiz list)');

      if (NET.ui && NET.ui.quiz && ctx.streaming) {
        var qz = NET.ui.quiz.show(id);
        ctx.line('Тест «' + qz.title + '» открыт во вкладке «Теория» (Alt+3): ' +
          qz.questions.length + ' вопросов, зачёт от ' + qz.passPercent + '%.');
        return 0;
      }

      /* Без интерфейса — только вопросы: отвечать удобнее во вкладке. */
      var quiz = NET.quiz.get(id);
      ctx.line('── Тест по командам: ' + quiz.title);
      quiz.questions.forEach(function (q, i) {
        ctx.line('');
        ctx.line((i + 1) + '. ' + q.q);
        var opts = q.options.slice().sort(function () { return Math.random() - 0.5; });
        opts.forEach(function (o, j) { ctx.line('   ' + String.fromCharCode(97 + j) + ') ' + o); });
      });
      return 0;
    }
  });

  reg({
    name: 'check', category: 'trainer', summary: 'проверить решение текущей лаборатории',
    usage: 'check',
    run: function (ctx) {
      var u = ui();
      if (u) {
        var r = u.check();
        return r && r.solved ? 0 : 1;
      }
      if (!NET.labs || !NET.labs.current()) return ctx.fail('check: активной лаборатории нет');
      var res = NET.labs.check();
      ctx.line('');
      res.results.forEach(function (r) {
        ctx.line('  [' + (r.ok ? '✔' : '✘') + '] ' + r.title + (r.detail ? ' — ' + r.detail : ''));
      });
      ctx.line('');
      if (res.solved) {
        ctx.line('Задача решена. Открыт разбор в правой панели.');
      } else {
        ctx.line('Ещё не всё: проверьте отмеченные пункты. Подсказка — команда hint.');
      }
      return res.solved ? 0 : 1;
    }
  });

  reg({
    name: 'hint', category: 'trainer', summary: 'следующая подсказка', usage: 'hint',
    run: function (ctx) {
      var u = ui();
      if (u) { u.hint(); return 0; }
      if (!NET.labs || !NET.labs.current()) return ctx.fail('hint: активной лаборатории нет');
      var h = NET.labs.hint();
      if (h.err) return ctx.fail('hint: ' + h.err);
      ctx.line('');
      ctx.line('Подсказка ' + h.index + '/' + h.total + ': ' + h.text);
      if (h.penalty) ctx.line('(в режиме «' + h.mode + '» подсказка учитывается при оценке)');
      return 0;
    }
  });

  reg({
    name: 'reset', category: 'trainer', summary: 'сбросить лабораторию', usage: 'reset',
    run: function (ctx) {
      var u = ui();
      if (u && NET.labs.current()) { u.reset(); return 0; }
      if (!NET.labs || !NET.labs.current()) return ctx.fail('reset: активной лаборатории нет');
      var r = NET.labs.reset();
      ctx.line(r.err ? r.err : 'Состояние лаборатории восстановлено.');
      return 0;
    }
  });

  reg({
    name: 'selftest', category: 'trainer', summary: 'самопроверка движка тренажёра',
    usage: 'selftest [-v]',
    run: function (ctx) {
      if (!NET.selftest) return ctx.fail('selftest: модуль не загружен');
      var res = NET.selftest.run({ verbose: ctx.argv.indexOf('-v') >= 0 });
      res.lines.forEach(function (l) { ctx.line(l); });
      return res.failed ? 1 : 0;
    }
  });

  reg({
    name: 'true', category: 'sys', summary: 'ничего не делает, код возврата 0', usage: 'true',
    run: function () { return 0; }
  });

  reg({
    name: 'false', category: 'sys', summary: 'ничего не делает, код возврата 1', usage: 'false',
    run: function () { return 1; }
  });

  reg({
    name: 'basename', category: 'fs', summary: 'имя файла без пути', usage: 'basename PATH [SUFFIX]',
    run: function (ctx) {
      if (!ctx.argv.length) return ctx.usageError('basename: missing operand');
      var base = String(ctx.argv[0]).replace(/\/+$/, '');
      base = base.slice(base.lastIndexOf('/') + 1);
      if (ctx.argv[1] && base.slice(-ctx.argv[1].length) === ctx.argv[1]) {
        base = base.slice(0, -ctx.argv[1].length);
      }
      ctx.line(base || '/');
      return 0;
    }
  });

  reg({
    name: 'dirname', category: 'fs', summary: 'путь без имени файла', usage: 'dirname PATH',
    run: function (ctx) {
      if (!ctx.argv.length) return ctx.usageError('dirname: missing operand');
      var p = String(ctx.argv[0]).replace(/\/+$/, '');
      var i = p.lastIndexOf('/');
      ctx.line(i > 0 ? p.slice(0, i) : (i === 0 ? '/' : '.'));
      return 0;
    }
  });

  reg({
    name: 'sleep', category: 'sys', summary: 'пауза', usage: 'sleep SECONDS',
    run: function (ctx) {
      var s = parseFloat(ctx.argv[0]);
      if (!isFinite(s) || s < 0) {
        return ctx.usageError('sleep: invalid time interval \'' + (ctx.argv[0] === undefined ? '' : ctx.argv[0]) + '\'');
      }
      return ctx.sleep(Math.min(s * 1000, 1500)).then(function () { return 0; });
    }
  });

  reg({
    name: 'watch', category: 'sys', summary: 'повторить команду', usage: 'watch [-n N] COMMAND',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { value: ['n'] });
      if (!p.rest.length) return ctx.usageError('Usage: watch [-n seconds] command');
      ctx.line('Every ' + (p.opts.n || 2) + '.0s: ' + p.rest.join(' ') + '   ' +
        ctx.machine.hostname + ': ' + new Date().toString().slice(16, 24));
      ctx.line('');
      return NET.shell.invokeAs(ctx, p.rest, ctx.user);
    }
  });
})(window.NET);
