/*
 * panel_debrief.js — разбор после задачи: что было сломано, почему такие
 * симптомы, какие команды были нужны, что упущено и что делать дальше.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};
  var last = null;

  var h = NET.ui.dom.h;

  function render() {
    var root = document.getElementById('tab-debrief');
    if (!root) return;
    root.textContent = '';
    if (!last) {
      root.appendChild(h('div', 'empty',
        'Разбор появится здесь после решения задачи: причина, симптомы, нужные команды ' +
        'и ваши пропущенные шаги диагностики.'));
      return;
    }
    var d = last;

    root.appendChild(h('div', 'task-title', d.title));
    var meta = h('div', 'task-meta');
    meta.appendChild(h('span', 'chip ok', 'оценка ' + d.score + ' · ' + d.grade));
    meta.appendChild(h('span', 'chip', 'время ' + fmtDuration(d.duration)));
    meta.appendChild(h('span', 'chip' + (d.hints ? ' warn' : ''), 'подсказок ' + d.hints));
    meta.appendChild(h('span', 'chip', 'диагностика ' + d.doneSteps + '/' + d.totalSteps));
    meta.appendChild(h('span', 'chip', d.mode));
    root.appendChild(meta);

    if (d.why) {
      root.appendChild(h('div', 'section-title', 'Почему были именно такие симптомы'));
      root.appendChild(h('div', 'debrief-why', d.why));
    }

    if (d.commands.length) {
      root.appendChild(h('div', 'section-title', 'Команды, которые решают задачу'));
      var table = h('div', 'cmd-table');
      d.commands.forEach(function (pair) {
        var row = h('div', 'c');
        var code = h('code', null, pair[0]);
        row.appendChild(code);
        row.appendChild(h('span', null, pair[1]));
        table.appendChild(row);
      });
      root.appendChild(table);
    }

    if (d.missedSteps.length) {
      root.appendChild(h('div', 'section-title', 'Вы это пропустили'));
      var ul = h('ul', 'compact');
      d.missedSteps.forEach(function (s) { ul.appendChild(h('li', null, s)); });
      root.appendChild(ul);
      root.appendChild(h('div', 'empty',
        'Эти шаги добавлены в очередь повторения — они вернутся в Quick Practice.'));
    }

    if (d.userCommands.length) {
      root.appendChild(h('div', 'section-title',
        'Ваши команды (' + d.userCommands.length + ' по делу' +
        (d.noiseCommands.length ? ', ' + d.noiseCommands.length + ' прочих' : '') + ')'));
      var pre = h('div', 'theory-card');
      pre.textContent = d.userCommands.slice(-14).join('\n');
      root.appendChild(pre);
    }

    if (d.theory) {
      root.appendChild(h('div', 'section-title', 'Теория: ' + d.theory.title));
      root.appendChild(h('div', 'theory-card', d.theory.text));
      if (d.theory.commands) {
        var t2 = h('div', 'cmd-table');
        d.theory.commands.forEach(function (c) {
          var row = h('div', 'c');
          row.appendChild(h('code', null, c));
          row.appendChild(h('span', null, ''));
          t2.appendChild(row);
        });
        root.appendChild(t2);
      }
    }

    if (d.pitfalls.length) {
      root.appendChild(h('div', 'section-title', 'Типичные ошибки'));
      var ul2 = h('ul', 'compact');
      d.pitfalls.forEach(function (p) { ul2.appendChild(h('li', null, p)); });
      root.appendChild(ul2);
    }

    if (d.nextVariant) {
      root.appendChild(h('div', 'section-title', 'Закрепить'));
      var btn = h('button', 'btn primary', d.nextVariant.title);
      btn.addEventListener('click', function () {
        if (d.nextVariant.kind === 'variant') {
          NET.ui.labs.start(d.nextVariant.labId, { variant: d.nextVariant.index });
        } else if (d.nextVariant.kind === 'lab') {
          NET.ui.labs.start(d.nextVariant.labId);
        } else {
          NET.modes.set('quick');
          NET.ui.labs.renderModes();
          NET.ui.task.quick.start('state');
        }
      });
      root.appendChild(btn);
    }
  }

  function fmtDuration(sec) {
    if (sec < 60) return sec + ' с';
    return Math.floor(sec / 60) + ' мин ' + (sec % 60) + ' с';
  }

  NET.bus.on('lab:solved', function (report) {
    last = NET.debrief.build(report);
    render();
    NET.ui.app.switchRightTab('debrief');
    var term = NET.ui.terminal;
    term.write('── Разбор ─────────────────────────────────\n', 'sys');
    term.write(last.why + '\n\n');
    if (last.missedSteps.length) {
      term.write('Пропущенные шаги диагностики:\n', 'hintline');
      last.missedSteps.forEach(function (s) { term.write('  · ' + s + '\n', 'hintline'); });
      term.write('\n');
    }
    if (last.nextVariant) {
      term.write(last.nextVariant.title + ' — кнопка в панели разбора справа.\n\n', 'dim');
    }
  });

  NET.ui.debrief = { render: render, last: function () { return last; } };
})(window.NET);
