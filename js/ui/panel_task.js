/*
 * panel_task.js — панель задания: текущая лабораторная или короткая задача,
 * чеклист проверки, подсказки. Здесь же контроллер режимов Quick Practice
 * и Command Trainer.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  NET.ui = NET.ui || {};

  /*
   * Журнал команд для Command Trainer. Пишем и отдельные команды пайплайна
   * (shell:exec), и строку целиком (terminal:run) — иначе задание вида
   * «ip a | grep -w inet» невозможно засчитать.
   */
  var cmdlog = [];
  function logCommand(line, machine) {
    cmdlog.push({ line: line, ts: Date.now(), machine: machine });
    if (cmdlog.length > 300) cmdlog.splice(0, 150);
  }
  NET.bus.on('shell:exec', function (ev) { logCommand(ev.line, ev.machine); });
  NET.bus.on('terminal:run', function (ev) { logCommand(ev.line, null); });

  var quick = {
    task: null,
    startedAt: 0,
    attempts: 0,
    hintShown: false,

    start: function (type) {
      var task = NET.srs.nextTask({ type: type });
      if (!task) {
        NET.ui.notify.warn('Нет подходящих заданий', 'Банк задач пуст для этого режима');
        return null;
      }
      NET.labs.stop();
      NET.world.rebuild();
      NET.world.capture.clear();
      try { if (task.setup) task.setup(NET.world); } catch (e) { console.error(e); }
      quick.task = task;
      quick.startedAt = Date.now();
      quick.attempts = 0;
      quick.hintShown = false;
      NET.bus.emit('quick:started', { task: task });
      render();
      if (NET.ui.terminal) {
        NET.ui.terminal.write('\n[' + (type === 'command' ? 'Command Trainer' : 'Quick Practice') + '] ' +
          task.prompt + '\n', 'sys');
        NET.ui.terminal.write('Проверка: Ctrl+Enter или команда check. Подсказка: F2\n\n', 'dim');
      }
      return task;
    },

    stop: function () { quick.task = null; render(); },

    check: function () {
      if (!quick.task) return null;
      quick.attempts++;
      var since = cmdlog.filter(function (c) { return c.ts >= quick.startedAt; });
      var res = NET.taskPool.check(quick.task, NET.world, since);
      NET.progress.recordTask(quick.task, res.ok, { mode: NET.modes.current() });
      NET.srs.afterTask(quick.task, res.ok);
      if (res.ok) {
        NET.ui.notify.ok('Задание выполнено', quick.task.solution ? 'Эталон: ' + quick.task.solution : '');
        if (NET.ui.terminal) {
          NET.ui.terminal.write('\n  [✔] задание выполнено', 'okline');
          if (quick.task.solution) {
            NET.ui.terminal.write('\n  эталонный вариант: ' + quick.task.solution, 'dim');
          }
          var th = quick.task.theory && NET.theory.get(quick.task.theory);
          if (th) NET.ui.terminal.write('\n  тема: ' + th.title, 'dim');
          NET.ui.terminal.write('\n\n');
        }
        quick.lastResult = res;
        quick.solved = true;
      } else {
        quick.solved = false;
        if (NET.ui.terminal) {
          NET.ui.terminal.write('\n  [✘] пока нет: ' + (res.detail || 'проверка не пройдена') + '\n\n', 'stderr');
        }
      }
      render();
      return res;
    },

    hint: function () {
      if (!quick.task) return;
      quick.hintShown = true;
      render();
      if (NET.ui.terminal) {
        NET.ui.terminal.write('\nПодсказка: ' + (quick.task.hint || '—') + '\n\n', 'hintline');
      }
    },

    next: function () {
      var mode = NET.modes.get();
      quick.start(mode.tasks === 'command' ? 'command' : 'state');
    }
  };

  /* ---------- отрисовка ---------- */

  var h = NET.ui.dom.h;

  var button = NET.ui.dom.button;

  function render() {
    var root = document.getElementById('tab-task');
    if (!root) return;
    root.textContent = '';

    if (quick.task) return renderQuick(root);
    var cur = NET.labs.current();
    if (cur) return renderLab(root, cur);
    return renderIdle(root);
  }

  function renderIdle(root) {
    root.appendChild(h('div', 'task-title', 'С чего начать'));
    var dueN = NET.srs ? NET.srs.dueCount() : 0;
    var overall = NET.progress.overall();

    var meta = h('div', 'task-meta');
    meta.appendChild(NET.ui.dom.levelChip(overall.level.id,
      overall.level.title + ' · ' + overall.percent + '%', 'accent'));
    meta.appendChild(h('span', 'chip', 'К повторению: ' + dueN));
    root.appendChild(meta);

    var next = null;
    var labs = NET.labs.list();
    for (var i = 0; i < labs.length; i++) {
      if (!NET.progress.isLabSolved(labs[i].id)) { next = labs[i]; break; }
    }
    var p = h('div', 'task-brief');
    p.textContent = next
      ? 'Следующая лабораторная по программе: ' + next.id.toUpperCase() + ' — ' + next.title + '.\n\n' +
        'Тренажёр устроен как работа: получаете инцидент, диагностируете командами в реальной ' +
        'виртуальной Ubuntu, чините конфигурацию и проверяете результат.'
      : 'Все лабораторные пройдены. Повторяйте слабые темы в Quick Practice — ' +
        'при повторном запуске лаборатория даёт другой вариант поломки.';
    root.appendChild(p);

    var actions = h('div', 'task-meta');
    if (next) {
      actions.appendChild(button('Начать ' + next.id.toUpperCase(), null, 'primary', function () {
        NET.ui.labs.start(next.id);
      }));
    }
    actions.appendChild(button('Quick Practice', null, '', function () {
      NET.modes.set('quick');
      quick.start('state');
    }));
    actions.appendChild(button('Command Trainer', null, '', function () {
      NET.modes.set('trainer');
      quick.start('command');
    }));
    root.appendChild(actions);

    if (dueN) {
      root.appendChild(h('div', 'section-title', 'К повторению сегодня'));
      var list = h('div', 'list');
      NET.srs.due(6).forEach(function (c) {
        var row = h('div', 'row static');
        row.appendChild(h('span', 't', c.title));
        row.appendChild(h('span', 'sub', c.lapses ? 'ошибок: ' + c.lapses : 'повтор'));
        list.appendChild(row);
      });
      root.appendChild(list);
    }
  }

  function renderQuick(root) {
    var t = quick.task;
    var mode = NET.modes.get();
    root.appendChild(h('div', 'task-title', mode.title));
    var meta = h('div', 'task-meta');
    var skill = NET.skills.get(t.skill);
    meta.appendChild(h('span', 'chip', skill ? skill.title : t.skill));
    meta.appendChild(h('span', 'chip warn', '★'.repeat(t.difficulty || 1)));
    meta.appendChild(h('span', 'chip', t.type === 'command' ? 'проверяется команда' : 'проверяется результат'));
    root.appendChild(meta);

    root.appendChild(h('div', 'task-brief', t.prompt));

    if (quick.solved) {
      var ok = h('div', 'task-goal');
      ok.textContent = 'Выполнено.' + (t.solution ? ' Эталон: ' + t.solution : '');
      root.appendChild(ok);
    }

    if (quick.hintShown) {
      root.appendChild(h('div', 'hint-box', t.hint || '—'));
    }

    var actions = h('div', 'task-meta');
    actions.appendChild(button('Проверить', '⌘↵', 'primary', function () { quick.check(); }));
    actions.appendChild(button('Подсказка', 'F2', '', function () { quick.hint(); }));
    actions.appendChild(button('Следующее', null, '', function () { quick.next(); }));
    actions.appendChild(button('Выйти', null, 'ghost', function () { quick.stop(); }));
    root.appendChild(actions);

    if (quick.solved && t.theory) {
      var card = NET.theory.get(t.theory);
      if (card) {
        root.appendChild(h('div', 'section-title', 'Почему это так: ' + card.title));
        root.appendChild(h('div', 'theory-card', card.text));
      }
    }
  }

  function renderLab(root, cur) {
    var lab = cur.lab;
    var mode = NET.modes.get(cur.mode);
    root.appendChild(h('div', 'task-title', lab.id.toUpperCase() + ' · ' + lab.title));

    var meta = h('div', 'task-meta');
    meta.appendChild(h('span', 'chip warn', '★'.repeat(lab.difficulty)));
    meta.appendChild(h('span', 'chip', mode.title));
    if (cur.variant && cur.variant.name) meta.appendChild(h('span', 'chip', 'вариант: ' + cur.variant.name));
    var st = NET.labs.stepStats();
    meta.appendChild(h('span', 'chip' + (st.done === st.total && st.total ? ' ok' : ''),
      'шаги диагностики: ' + st.done + '/' + st.total));
    if (cur.hintsUsed) meta.appendChild(h('span', 'chip warn', 'подсказок: ' + cur.hintsUsed));
    root.appendChild(meta);

    /*
     * Troubleshooting Mode: инженеру не рассказывают симптомы — только жалобу.
     * Раньше панель всё равно печатала полный бриф и обесценивала режим.
     */
    if (mode.blindBrief) {
      root.appendChild(h('div', 'task-brief',
        'Инцидент: пользователи сообщают, что «не работает».\n' +
        'Подробностей нет. Определите, что именно сломано, и восстановите работу.\n\n' +
        'Начните снизу: интерфейс → адрес и маска → маршруты → шлюз → DNS → сервис → firewall.'));
    } else {
      root.appendChild(h('div', 'task-brief', cur.variant.brief || lab.brief));
      if (lab.goal) root.appendChild(h('div', 'task-goal', 'Цель: ' + lab.goal));
    }

    var actions = h('div', 'task-meta');
    actions.appendChild(button('Проверить', '⌘↵', 'primary', function () { NET.ui.labs.check(); }));
    if (mode.hints !== false) {
      actions.appendChild(button('Подсказка', 'F2', '', function () { NET.ui.labs.hint(); }));
    }
    actions.appendChild(button('Сброс', 'F5', 'ghost', function () { NET.ui.labs.reset(); }));
    root.appendChild(actions);

    if (cur.lastCheck) {
      root.appendChild(h('div', 'section-title', 'Проверка решения'));
      var list = h('div', 'checklist');
      cur.lastCheck.forEach(function (r) {
        var item = h('div', 'item ' + (r.ok ? 'pass' : 'fail'));
        item.appendChild(h('span', 'mark', r.ok ? '✔' : '✘'));
        var body = h('div');
        body.appendChild(h('div', null, r.title));
        if (!r.ok && r.detail) body.appendChild(h('div', 'detail', r.detail));
        item.appendChild(body);
        list.appendChild(item);
      });
      root.appendChild(list);
    }

    if (cur.shownHints && cur.shownHints.length) {
      root.appendChild(h('div', 'section-title', 'Подсказки'));
      cur.shownHints.forEach(function (text, i) {
        root.appendChild(h('div', 'hint-box', (i + 1) + '. ' + text));
      });
    }

    if (st.total) {
      root.appendChild(h('div', 'section-title', 'Шаги диагностики'));
      var steps = h('div', 'checklist');
      (cur.variant.keySteps || []).forEach(function (s) {
        var done = !!cur.steps[s.id];
        var item = h('div', 'item ' + (done ? 'pass' : ''));
        item.appendChild(h('span', 'mark', done ? '✔' : '·'));
        item.appendChild(h('div', null, s.title));
        steps.appendChild(item);
      });
      root.appendChild(steps);
    }
  }

  NET.ui.task = { render: render, quick: quick, cmdlog: cmdlog };
})(window.NET);
