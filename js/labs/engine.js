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

  /*
   * Разделы курса. Лаборатория без поля track относится к диагностике;
   * track: 'security' — раздел «Безопасность» (сервер под атакой).
   */
  var TRACKS = [
    { id: 'diag', title: 'Диагностика сети', short: 'Диагностика',
      desc: 'Сервер сломан: найти причину и восстановить работу.' },
    { id: 'security', title: 'Безопасность', short: 'Безопасность',
      desc: 'Сервер атакуют: отразить атаку и закрыть возможность её повторить.' }
  ];

  function trackOf(lab) { return lab && lab.track === 'security' ? 'security' : 'diag'; }

  function byTrack(id) {
    return list().filter(function (lab) { return trackOf(lab) === id; });
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
      keySteps: lab.keySteps,
      solution: lab.solution || null
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
        keySteps: m.keySteps || lab.keySteps,
        solution: m.solution || null
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
      },

      /*
       * Netplan хоста с правкой одного интерфейса: берётся текущая спецификация
       * (после пересборки мира — эталон из топологии), поля patch заменяют
       * одноимённые, значение null удаляет поле. Конфигурация записывается
       * в файл и применяется, поэтому поломка переживает reboot.
       *   h.netplanPatch('srv1', { addresses: ['192.168.10.20/28'] })
       *   h.netplanPatch('srv1', { routes: null })            // убрать шлюз
       */
      netplanPatch: function (hostName, patch, opts) {
        opts = opts || {};
        var m = world.get(hostName);
        var doc = U.clone(m.netplanSpec || { network: { version: 2, renderer: 'networkd', ethernets: {} } });
        var eths = doc.network.ethernets = doc.network.ethernets || {};
        var name = opts.iface || Object.keys(eths)[0] || 'ens33';
        var dev = eths[name] = eths[name] || {};
        Object.keys(patch || {}).forEach(function (k) {
          if (NET.schema.isUnsafeKey(k)) return;
          if (patch[k] === null) delete dev[k];
          else dev[k] = U.clone(patch[k]);
        });
        this.writeNetplan(hostName, doc);
        if (opts.apply !== false) this.applyNetplan(hostName);
        return doc;
      },

      /* Файл целиком (root:root, по умолчанию 0644); каталоги создаются при необходимости. */
      writeFile: function (hostName, path, content, mode) {
        var m = world.get(hostName);
        var dir = path.slice(0, path.lastIndexOf('/'));
        if (dir && !m.vfs.exists(dir, NET.ROOTCTX)) {
          m.vfs.mkdir(dir, NET.ROOTCTX, { parents: true, mode: 0o755 });
        }
        m.vfs.write(path, content, NET.ROOTCTX, { mode: mode === undefined ? 0o644 : mode });
      },

      /* Дописать строки в конец файла (например, запись в /etc/hosts). */
      appendFile: function (hostName, path, text) {
        var m = world.get(hostName);
        var cur = m.vfs.exists(path, NET.ROOTCTX) ? m.vfs.read(path, NET.ROOTCTX) : '';
        if (cur && cur.charAt(cur.length - 1) !== '\n') cur += '\n';
        m.vfs.write(path, cur + text + (/\n$/.test(text) ? '' : '\n'), NET.ROOTCTX);
      },

      /* Правка файла заменой (строка или RegExp), как sed -i. */
      editFile: function (hostName, path, find, repl) {
        var m = world.get(hostName);
        var cur = m.vfs.read(path, NET.ROOTCTX);
        var next = cur.replace(find, repl);
        if (next === cur) throw new Error('editFile: в ' + path + ' нечего заменять');
        m.vfs.write(path, next, NET.ROOTCTX);
      },

      /*
       * Параметр ядра: сразу в работающую систему и, если указан файл,
       * постоянно — в /etc/sysctl.d/<file>, чтобы значение пережило reboot.
       */
      sysctl: function (hostName, key, value, file) {
        var m = world.get(hostName);
        m.net.sysctl[key] = String(value);
        if (file) this.appendFile(hostName, '/etc/sysctl.d/' + file, key + ' = ' + value);
      },

      /* ---------- помощники раздела «Безопасность» ---------- */

      /* Установить fail2ban (по умолчанию не запущен и не включён). */
      fail2ban: function (hostName, opts) {
        NET.fail2ban.install(world.get(hostName), opts || {});
      },

      /*
       * Записать в журнал sshd серию неудачных попыток входа с адреса —
       * «идёт перебор паролей». Если на хосте работает fail2ban с
       * включённым jail, он тут же посчитает попытки и забанит.
       */
      bruteForce: function (hostName, ip, count, opts) {
        opts = opts || {};
        var m = world.get(hostName);
        var user = opts.user || 'root';
        for (var i = 0; i < (count || 1); i++) {
          m.log('sshd', 'Failed password for ' + (opts.invalid ? 'invalid user ' : '') + user +
            ' from ' + ip + ' port ' + (40000 + i) + ' ssh2');
        }
      },

      /*
       * Поставить сервер под нагрузку с внешних адресов:
       *   kind 'syn'  — SYN-флуд на порт; спасают SYN cookies;
       *   kind 'conn' — исчерпание соединений с адресов sources; спасает
       *                 всё, что не пускает эти адреса к порту (deny/limit/fail2ban).
       */
      flood: function (hostName, spec) {
        var m = world.get(hostName);
        m.quirks = m.quirks || {};
        m.quirks.floods = (m.quirks.floods || []).filter(function (f) {
          return Number(f.port) !== Number(spec.port || 80);
        });
        m.quirks.floods.push({
          kind: spec.kind || 'conn', port: spec.port || 80,
          sources: spec.sources || ['198.51.100.66', '198.51.100.67', '198.51.100.68']
        });
        if ((spec.kind || 'conn') === 'syn') {
          /* как настоящее ядро: с включёнными SYN cookies — «Sending cookies»,
             без них — «Dropping request» (очередь переполнена, клиент отброшен) */
          var cookies = String((m.net.sysctl || {})['net.ipv4.tcp_syncookies']) !== '0';
          m.log('kernel', 'TCP: request_sock_TCP: Possible SYN flooding on port ' + (spec.port || 80) +
            (cookies ? '. Sending cookies.' : '. Dropping request.  Check SNMP counters.'), 'warning');
        }
        /* полуоткрытые соединения видны в ss -tan state syn-recv */
        if ((spec.kind || 'conn') === 'syn') {
          var local = m.net.primaryIP();
          for (var i = 0; i < (spec.halfOpen || 24); i++) {
            m.net.sockets.push({
              proto: 'tcp', addr: local, port: spec.port || 80, state: 'SYN-RECV',
              peerAddr: '198.51.100.' + (2 + (i % 250)), peerPort: 30000 + i,
              pid: null, process: null, unit: null, ts: Date.now()
            });
          }
        }
      },

      /* Строки в /var/log/nginx/access.log (формат combined), как от реальных запросов. */
      accessLog: function (hostName, entries) {
        var lines = entries.map(function (e) {
          return NET.httpd.logLine(e.ip, e.method || 'GET', e.path, e.status === undefined ? 200 : e.status,
            e.size === undefined ? 612 : e.size, e.ua, e.ts);
        });
        this.appendFile(hostName, '/var/log/nginx/access.log', lines.join('\n'));
      },

      /* Служба, слушающая адрес из своего конфига (Redis, MySQL и пр.). */
      service: function (hostName, spec) {
        var m = world.get(hostName);
        if (spec.configFile && spec.configText !== undefined) {
          this.writeFile(hostName, spec.configFile, spec.configText, spec.mode);
        }
        if (!m.services.get(spec.name)) {
          m.services.define({
            name: spec.name, description: spec.description || spec.name,
            exec: spec.exec || ('/usr/bin/' + spec.name), ports: spec.ports || [],
            state: 'inactive', enabled: spec.enabled !== false, bindFrom: spec.bindFrom || null
          });
        }
        if (spec.start !== false) m.services.start(spec.name);
        return m.services.get(spec.name);
      },

      /* Создать пользователя (для сценариев «лишний аккаунт»). */
      addUser: function (hostName, spec) {
        return world.get(hostName).users.addUser(spec);
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
    tracks: TRACKS,
    trackOf: trackOf,
    byTrack: byTrack,
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
