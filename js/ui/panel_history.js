/* panel_history.js — история обучения */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};

  var h = NET.ui.dom.h;

  function render() {
    var root = document.getElementById('tab-history');
    if (!root) return;
    root.textContent = '';
    var p = NET.progress.get();
    var items = p.history.slice().reverse();

    var meta = h('div', 'task-meta');
    meta.appendChild(h('span', 'chip', 'решено лабораторий: ' + p.totals.labsSolved));
    meta.appendChild(h('span', 'chip', 'коротких задач: ' + p.totals.tasksSolved));
    meta.appendChild(h('span', 'chip', 'время: ' + Math.round(p.totals.seconds / 60) + ' мин'));
    meta.appendChild(h('span', 'chip', 'команд: ' + p.totals.commands));
    root.appendChild(meta);

    root.appendChild(h('div', 'section-title', 'Последние результаты'));
    if (!items.length) {
      root.appendChild(h('div', 'empty', 'Пока пусто. Решите первую лабораторию — здесь появится история.'));
    } else {
      var list = h('div', 'list');
      items.slice(0, 40).forEach(function (it) {
        var row = h('div', 'row static');
        row.appendChild(h('span', it.score >= 70 ? 'ok' : (it.score > 0 ? 'warn' : 'err'),
          it.kind === 'lab' ? '▣' : '·'));
        var t = h('span', 't', it.title);
        row.appendChild(t);
        row.appendChild(h('span', 'sub', new Date(it.at).toLocaleString().replace(',', '')));
        row.appendChild(h('span', 'sub', it.score + '%'));
        list.appendChild(row);
      });
      root.appendChild(list);
    }

    var weak = NET.progress.weakSkills(4).filter(function (s) { return s.percent < 62; });
    if (weak.length) {
      root.appendChild(h('div', 'section-title', 'Слабые навыки — стоит подтянуть'));
      var l2 = h('div', 'list');
      weak.forEach(function (s) {
        var row = h('div', 'row');
        row.appendChild(h('span', 'warn', '!'));
        row.appendChild(h('span', 't', s.title));
        row.appendChild(h('span', 'sub', s.percent + '% · ' + s.level.title));
        row.addEventListener('click', function () {
          var task = NET.taskPool.pick({ skill: s.id });
          if (!task) { NET.ui.notify.info('Нет короткой задачи', s.title); return; }
          NET.modes.set(task.type === 'command' ? 'trainer' : 'quick');
          NET.ui.labs.renderModes();
          NET.ui.task.quick.start(task.type);
        });
        l2.appendChild(row);
      });
      root.appendChild(l2);
    }
  }

  NET.bus.on('progress:updated', function () {
    var pane = document.getElementById('tab-history');
    if (pane && pane.classList.contains('active')) render();
  });

  NET.ui.history = { render: render };
})(window.NET);
