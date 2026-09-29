/*
 * panel_labs.js — список лабораторий, выбор режима и контроллер,
 * связывающий движок лабораторий с интерфейсом и терминалом.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  NET.ui = NET.ui || {};

  var D = NET.ui.dom;
  var h = D.h;

  /* Строка списка только раскрывает карточку: запуск — отдельной кнопкой,
     чтобы случайный клик не сбрасывал текущую работу и состояние мира. */
  var selectedId = null;

  /* ---------- контроллер ---------- */

  var ctl = {
    start: function (id, opts) {
      opts = opts || {};
      var mode = NET.modes.get();
      var res = NET.labs.start(id, { fresh: true, variant: opts.variant });
      if (res.err) { NET.ui.notify.err('Не удалось запустить', res.err); return; }
      selectedId = null;
      var cur = NET.labs.current();
      cur.shownHints = [];
      cur.lastCheck = null;
      NET.ui.task.quick.stop();
      NET.ui.task.render();
      renderList();
      NET.ui.app.switchRightTab('task');
      var term = NET.ui.terminal;
      term.write('\n');
      term.write('══ ' + res.lab.id.toUpperCase() + ': ' + res.lab.title + ' ══\n', 'sys');
      var brief = (mode.blindBrief ? 'Инцидент: «не работает». Симптомы не уточнены — выясните сами.' :
        (res.variant.brief || res.lab.brief));
      term.write(brief + '\n');
      if (res.lab.goal && !mode.blindBrief) term.write('\nЦель: ' + res.lab.goal + '\n');
      term.write('\nРежим: ' + mode.title + '. Проверка — check (Ctrl+Enter)' +
        (mode.hints === false ? ', подсказки отключены' : ', подсказка — hint (F2)') + '.\n\n', 'dim');
      NET.ui.notify.info('Лаборатория запущена', res.lab.title);
    },

    check: function () {
      var cur = NET.labs.current();
      if (!cur) {
        if (NET.ui.task.quick.task) return NET.ui.task.quick.check();
        NET.ui.notify.warn('Нет активной задачи', 'Выберите лабораторию слева');
        return null;
      }
      var res = NET.labs.check();
      cur.lastCheck = res.results;
      NET.ui.task.render();
      var term = NET.ui.terminal;
      term.write('\n');
      res.results.forEach(function (r) {
        term.write('  [' + (r.ok ? '✔' : '✘') + '] ' + r.title +
          (r.ok ? '' : (r.detail ? ' — ' + r.detail : '')) + '\n', r.ok ? 'okline' : 'stderr');
      });
      term.write('\n');
      if (res.solved) {
        term.write('Задача решена. Разбор открыт в правой панели.\n\n', 'okline');
        NET.ui.notify.ok('Решено: ' + cur.lab.title, 'Оценка ' + res.report.score + ' — ' + res.report.grade);
      } else {
        term.write('Ещё не всё. Смотрите непройденные пункты выше.\n\n', 'hintline');
      }
      renderList();
      return res;
    },

    hint: function () {
      var cur = NET.labs.current();
      if (!cur) {
        if (NET.ui.task.quick.task) return NET.ui.task.quick.hint();
        return;
      }
      var hh = NET.labs.hint();
      if (hh.err) { NET.ui.notify.warn('Подсказка недоступна', hh.err); return; }
      cur.shownHints = cur.shownHints || [];
      if (!hh.repeat) cur.shownHints.push(hh.text);
      NET.ui.task.render();
      NET.ui.terminal.write('\nПодсказка ' + hh.index + '/' + hh.total + ': ' + hh.text + '\n\n', 'hintline');
    },

    reset: function () {
      var cur = NET.labs.current();
      if (!cur) return;
      NET.labs.reset();
      cur.lastCheck = null;
      NET.ui.task.render();
      NET.ui.terminal.write('\n[состояние лаборатории восстановлено]\n\n', 'sys');
      NET.ui.notify.info('Сброшено', 'Мир вернулся в исходное состояние задачи');
    },

    startRandom: function () {
      var labs = NET.labs.list();
      var unsolved = labs.filter(function (l) { return !NET.progress.isLabSolved(l.id); });
      var pick = U.pick(unsolved.length ? unsolved : labs);
      ctl.start(pick.id);
    }
  };

  /* ---------- список лабораторий ---------- */

  /* Раскрыть карточку лаборатории (повторный клик сворачивает её). */
  function select(id) {
    selectedId = selectedId === id ? null : id;
    renderList();
  }

  /* Карточка под строкой: о чём задача и единственная кнопка запуска. */
  function detail(lab, cur) {
    var box = h('div', 'lab-detail');
    var mode = NET.modes.get();
    box.appendChild(h('div', 'lab-detail-brief', mode.blindBrief ?
      'Режим «Troubleshooting»: симптомы не раскрываются до запуска.' : lab.brief));

    var meta = h('div', 'lab-detail-meta');
    meta.appendChild(h('span', null, 'сложность ' + '★'.repeat(lab.difficulty)));
    (lab.skills || []).slice(0, 3).forEach(function (id) {
      var sk = NET.skills.get(id);
      meta.appendChild(h('span', null, sk ? sk.title : id));
    });
    box.appendChild(meta);

    var running = !!(cur && cur.lab.id === lab.id);
    var actions = h('div', 'lab-detail-actions');
    actions.appendChild(D.button(running ? 'Запустить заново' : 'Запустить', null, 'small primary',
      function () { ctl.start(lab.id); }));
    var lesson = NET.lessons && NET.lessons.forLab(lab.id);
    if (lesson) {
      actions.appendChild(D.button('Теория', null, 'small ghost', function () {
        NET.ui.lesson.show(lesson.id);
      }));
    }
    if (running) {
      actions.appendChild(h('span', 'lab-detail-note', 'идёт сейчас'));
    }
    box.appendChild(actions);
    return box;
  }

  function renderList() {
    var box = document.getElementById('labs-list');
    if (!box) return;
    box.textContent = '';
    var cur = NET.labs.current();
    var solvedCount = 0;

    /* Два раздела: диагностика и безопасность. Заголовок печатается,
       только если в разделе есть задачи, — порядок задаёт NET.labs.tracks. */
    NET.labs.tracks.forEach(function (track) {
      var inTrack = NET.labs.byTrack(track.id);
      if (!inTrack.length) return;
      var solvedHere = inTrack.filter(function (l) { return NET.progress.isLabSolved(l.id); }).length;
      var head = h('div', 'list-group');
      head.appendChild(h('span', 't', track.title));
      head.appendChild(h('span', 'count', solvedHere + '/' + inTrack.length));
      head.title = track.desc;
      box.appendChild(head);

      inTrack.forEach(function (lab) {
        var solved = NET.progress.isLabSolved(lab.id);
        if (solved) solvedCount++;
        var open = selectedId === lab.id;
        var row = h('div', 'row' + (cur && cur.lab.id === lab.id ? ' active' : '') +
          (open ? ' selected' : ''));
        row.title = lab.title + ' — сложность ' + lab.difficulty + '. Нажмите, чтобы раскрыть описание';
        row.appendChild(h('span', solved ? 'done' : 'faint', solved ? '✔' : '·'));
        var t = h('span', 't');
        t.textContent = lab.id.toUpperCase() + ' ' + lab.title;
        row.appendChild(t);
        row.appendChild(h('span', 'stars', '★'.repeat(lab.difficulty)));
        row.appendChild(h('span', 'caret', open ? '▾' : '▸'));
        row.addEventListener('click', function () { select(lab.id); });
        box.appendChild(row);
        if (open) box.appendChild(detail(lab, cur));
      });
    });

    var counter = document.getElementById('labs-count');
    if (counter) counter.textContent = solvedCount + '/' + NET.labs.list().length;
  }

  /* ---------- режимы ---------- */

  function renderModes() {
    var box = document.getElementById('modes-grid');
    if (!box) return;
    box.textContent = '';
    NET.modes.list.forEach(function (m) {
      var b = h('button', 'mode-btn' + (NET.modes.current() === m.id ? ' active' : ''), m.short);
      b.title = m.desc;
      b.addEventListener('click', function () { selectMode(m.id); });
      box.appendChild(b);
    });
    var desc = document.getElementById('mode-desc');
    if (desc) desc.textContent = NET.modes.get().desc;
  }

  function selectMode(id) {
    NET.modes.set(id);
    renderModes();
    var m = NET.modes.get();
    NET.ui.app.updateTopbar();
    if (m.tasks === 'command') { NET.ui.task.quick.start('command'); return; }
    if (m.tasks === 'state') { NET.ui.task.quick.start('state'); return; }
    if (m.random) {
      NET.ui.task.quick.stop();
      ctl.startRandom();
      return;
    }
    NET.ui.task.quick.stop();
    NET.ui.task.render();
  }

  NET.bus.on('progress:updated', renderList);
  NET.bus.on('lab:step', function () { NET.ui.task.render(); });

  NET.ui.labs = {
    start: ctl.start,
    check: ctl.check,
    hint: ctl.hint,
    reset: ctl.reset,
    startRandom: ctl.startRandom,
    renderList: renderList,
    select: select,
    selected: function () { return selectedId; },
    renderModes: renderModes,
    selectMode: selectMode
  };
})(window.NET);
