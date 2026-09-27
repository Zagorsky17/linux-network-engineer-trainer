/*
 * engine.js — жизненный цикл лаборатории:
 *   load -> setup(world) -> running -> check -> debrief -> mutation/repeat
 *
 * Движок отслеживает каждую введённую команду, чтобы отличить осознанную
 * диагностику от угадывания и построить честный разбор.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var labs = NET.registries.labs;
  var order = [];

  var state = null;

  function register(def) {
    labs[def.id] = def;
    order.push(def.id);
    return def;
  }

  function list() {
    return order.map(function (id) { return labs[id]; });
  }

  function get(id) { return labs[id] || null; }

  /* Вариант = базовая постановка или одна из мутаций той же задачи. */
  function variants(lab) {
    var base = {
      id: lab.id + '/base',
      name: lab.variantName || 'базовый',
      setup: lab.setup,
      checks: lab.checks,
      hints: lab.hints,
      brief: lab.brief,
      debrief: lab.debrief,
      keySteps: lab.keySteps
    };
    var all = [base];
    (lab.mutations || []).forEach(function (m, i) {
      all.push({
        id: lab.id + '/m' + (i + 1),
        name: m.name || ('вариант ' + (i + 1)),
        setup: m.setup,
        checks: m.checks || lab.checks,
        hints: m.hints || lab.hints,
        brief: m.brief || lab.brief,
        debrief: m.debrief || lab.debrief,
        keySteps: m.keySteps || lab.keySteps
      });
    });
    return all;
  }

  function start(id, opts) {
    opts = opts || {};
    var lab = get(id);
    if (!lab) return { err: 'нет лаборатории ' + id };
    var world = NET.world;
    if (!world) return { err: 'мир не инициализирован' };

    var vs = variants(lab);
    var idx;
    if (opts.variant !== undefined && vs[opts.variant]) idx = opts.variant;
    else if (opts.fresh && vs.length > 1) {
      /*
       * Первое знакомство — базовый сценарий (он же описан в программе курса).
       * Повторное прохождение выдаёт ещё не пройденный вариант, поэтому
       * заучить ответ нельзя: поломка каждый раз другая.
       */
      var solvedVariants = (NET.progress && NET.progress.solvedVariants(id)) || [];
      if (!solvedVariants.length) idx = 0;
      else {
        var unseen = vs.map(function (v, i) { return i; }).filter(function (i) {
          return solvedVariants.indexOf(vs[i].id) < 0;
        });
        idx = unseen.length ? U.pick(unseen) : U.randInt(0, vs.length - 1);
      }
    } else idx = 0;

    var variant = vs[idx];

    world.rebuild();
    world.capture.clear();

    var helpers = makeHelpers(world);
    try {
      if (variant.setup) variant.setup(world, helpers);
    } catch (e) {
      console.error('lab setup failed', e);
      return { err: 'ошибка подготовки сценария: ' + e.message };
    }

    state = {
      lab: lab,
      variant: variant,
      variantIndex: idx,
      startedAt: Date.now(),
      hintsUsed: 0,
      commands: [],
      steps: {},
      solved: false,
      attempts: 0,
      mode: (NET.modes && NET.modes.current()) || 'learn',
      snapshot: world.snapshot()
    };

    NET.bus.emit('lab:started', { lab: lab, variant: variant, mode: state.mode });
    return { ok: true, lab: lab, variant: variant };
  }

  /* Утилиты, которыми сценарии ломают мир. */
  function makeHelpers(world) {
    return {
      world: world,
      host: function (n) { return world.get(n); },
      /* Синхронизировать netplan-файл с текущим состоянием (чтобы поломка пережила reboot) */
      writeNetplan: function (hostName, doc) {
        var m = world.get(hostName);
        m.netplanSpec = doc;
        m.vfs.write('/etc/netplan/01-netcfg.yaml',
          '# This file describes the network interfaces available on your system\n' +
          '# For more information, see netplan(5).\n' + NET.netcfg.renderYaml(doc) + '\n',
          NET.ROOTCTX, { mode: 0o600 });
      },
      applyNetplan: function (hostName) {
        var m = world.get(hostName);
        var loaded = NET.netcfg.loadFiles(m);
        NET.netcfg.apply(world, m, loaded.doc);
      },
      log: function (hostName, unit, msg, prio) {
        world.get(hostName).log(unit, msg, prio);
      }
    };
  }

  function current() { return state; }

  function commands() {
    if (!state) return [];
    return state.commands.concat(state.lines || []);
  }

  function reset() {
    if (!state) return { err: 'активной лаборатории нет' };
    NET.world.restore(state.snapshot);
    state.commands = [];
    state.steps = {};
    state.attempts = 0;
    NET.world.capture.clear();
    NET.bus.emit('lab:reset', { lab: state.lab });
    return { ok: true };
  }

  function stop() {
    state = null;
    NET.bus.emit('lab:stopped', {});
  }

  /* ---------- отслеживание команд ---------- */

  function markSteps(line, ev) {
    var steps = state.variant.keySteps || [];
    steps.forEach(function (s) {
      if (state.steps[s.id]) return;
      var hit = typeof s.match === 'function' ? s.match(line, ev) : s.match.test(line);
      if (hit) {
        state.steps[s.id] = true;
        NET.bus.emit('lab:step', { step: s, done: Object.keys(state.steps).length, total: steps.length });
      }
    });
  }

  NET.bus.on('shell:exec', function (ev) {
    if (!state) return;
    state.commands.push({ line: ev.line, machine: ev.machine, ts: Date.now() });
    /* длинная сессия не должна копить команды без предела */
    var cap = NET.util.LIMITS.labCommands;
    if (state.commands.length > cap) state.commands.splice(0, state.commands.length - cap);
    markSteps(ev.line, ev);
  });

  /*
   * Пайплайн приходит в shell:exec по частям, поэтому целую строку берём из
   * терминала: иначе шаг вида «tcpdump ... | grep» не был бы засчитан.
   */
  NET.bus.on('terminal:run', function (ev) {
    if (!state || !ev.line || ev.line.indexOf('|') < 0) return;
    state.lines = state.lines || [];
    state.lines.push({ line: ev.line, ts: Date.now() });
    if (state.lines.length > 500) state.lines.splice(0, state.lines.length - 500);
    markSteps(ev.line, ev);
  });

  function stepStats() {
    if (!state) return { done: 0, total: 0, missed: [] };
    var steps = state.variant.keySteps || [];
    var missed = steps.filter(function (s) { return !state.steps[s.id]; });
    return { done: steps.length - missed.length, total: steps.length, missed: missed };
  }

  function progressText() {
    var s = stepStats();
    return s.done + '/' + s.total;
  }

  /* ---------- проверка ---------- */

  function check() {
    if (!state) return { err: 'активной лаборатории нет' };
    state.attempts++;
    var world = NET.world;
    var results = (state.variant.checks || []).map(function (c) {
      var r;
      try { r = c.run(world, NET.labs); } catch (e) {
        console.error(e);
        r = { ok: false, detail: 'ошибка проверки' };
      }
      return { title: c.title, ok: !!r.ok, detail: r.detail || null };
    });
    var solved = results.length > 0 && results.every(function (r) { return r.ok; });
    NET.bus.emit('lab:checked', { results: results, solved: solved });

    if (solved && !state.solved) {
      state.solved = true;
      var report = finish(results);
      NET.bus.emit('lab:solved', report);
      return { results: results, solved: true, report: report };
    }
    return { results: results, solved: solved };
  }

  function finish(results) {
    var st = stepStats();
    var duration = Math.round((Date.now() - state.startedAt) / 1000);
    var coverage = st.total ? st.done / st.total : 1;
    var hintPenalty = state.hintsUsed * (state.mode === 'exam' ? 25 : 12);
    var attemptPenalty = Math.max(0, state.attempts - 1) * 5;
    var base = 60 + coverage * 40;
    var score = Math.max(5, Math.round(base - hintPenalty - attemptPenalty));
    var grade = score >= 90 ? 'отлично' : (score >= 70 ? 'хорошо' : (score >= 50 ? 'удовлетворительно' : 'решено с помощью'));

    var report = {
      labId: state.lab.id,
      variantId: state.variant.id,
      title: state.lab.title,
      score: score,
      grade: grade,
      duration: duration,
      hints: state.hintsUsed,
      attempts: state.attempts,
      coverage: coverage,
      steps: st,
      commands: state.commands.slice(),
      skills: state.lab.skills || [],
      difficulty: state.lab.difficulty || 1,
      debrief: state.variant.debrief || {},
      results: results,
      mode: state.mode
    };

    if (NET.progress) NET.progress.recordLab(report);
    if (NET.srs) NET.srs.afterLab(report);
    return report;
  }

  /* ---------- подсказки ---------- */

  function hint() {
    if (!state) return { err: 'активной лаборатории нет' };
    var hints = state.variant.hints || [];
    if (!hints.length) return { err: 'для этой задачи подсказок нет' };
    var mode = NET.modes ? NET.modes.get(state.mode) : null;
    if (mode && mode.hints === false) {
      return { err: 'в режиме «' + mode.title + '» подсказки отключены' };
    }
    if (state.hintsUsed >= hints.length) {
      return { index: hints.length, total: hints.length, text: hints[hints.length - 1], repeat: true };
    }
    var text = hints[state.hintsUsed];
    state.hintsUsed++;
    NET.bus.emit('lab:hint', { index: state.hintsUsed, total: hints.length, text: text });
    return {
      index: state.hintsUsed, total: hints.length, text: text,
      penalty: true, mode: mode ? mode.title : state.mode
    };
  }

  /* ---------- текст задания ---------- */

  function briefText(lab) {
    var v = state && state.lab === lab ? state.variant : null;
    var brief = (v && v.brief) || lab.brief;
    var lines = [];
    lines.push('── ' + lab.id.toUpperCase() + ': ' + lab.title + ' ' + '★'.repeat(lab.difficulty));
    lines.push('');
    brief.split('\n').forEach(function (l) { lines.push(l); });
    if (lab.goal) {
      lines.push('');
      lines.push('Цель: ' + lab.goal);
    }
    if (state && state.lab === lab) {
      lines.push('');
      lines.push('Проверить решение: check   Подсказка: hint   Сбросить: reset');
    }
    return lines.join('\n');
  }

  function isSolved(id) {
    return NET.progress ? NET.progress.isLabSolved(id) : false;
  }

  NET.labs = {
    register: register,
    list: list,
    get: get,
    variants: variants,
    start: start,
    reset: reset,
    stop: stop,
    check: check,
    hint: hint,
    current: current,
    commands: commands,
    stepStats: stepStats,
    progressText: progressText,
    briefText: briefText,
    isSolved: isSolved
  };
})(window.NET);
