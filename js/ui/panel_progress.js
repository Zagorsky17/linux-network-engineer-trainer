/*
 * panel_progress.js — профиль специалиста: навыки, уровни, очередь повторения,
 * экспорт/импорт прогресса.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};

  var h = NET.ui.dom.h;

  function renderSkills() {
    var box = document.getElementById('skills-list');
    if (!box) return;
    box.textContent = '';
    var view = NET.progress.skillsView();
    view.forEach(function (s) {
      var row = h('div', 'skill-row');
      var top = h('div', 'top');
      top.appendChild(h('span', 'level-dot level-' + s.level.id));
      top.appendChild(h('span', null, s.title));
      top.appendChild(h('span', 'pct', s.percent + '%'));
      row.appendChild(top);
      var bar = h('div', 'bar' + (s.percent >= 62 ? ' ok' : (s.percent >= 20 ? '' : ' warn')));
      var i = h('i');
      i.style.width = Math.max(2, s.percent) + '%';
      bar.appendChild(i);
      row.appendChild(bar);
      var sub = h('div', 'sub faint');
      sub.textContent = s.level.title + ' · решено ' + s.stats.solved +
        (s.stats.failed ? ' · ошибок ' + s.stats.failed : '') +
        (s.weak.length ? ' · слабое: ' + s.weak.length : '');
      row.appendChild(sub);
      row.title = s.desc + (s.level.next ? '\nДо ' + s.level.next + ': +' + s.level.toNext + '%' : '');
      box.appendChild(row);
    });

    var overall = NET.progress.overall();
    var sum = document.getElementById('skills-summary');
    if (sum) {
      sum.textContent = '';
      sum.appendChild(NET.ui.dom.levelChip(overall.level.id,
        overall.level.title + ' · ' + overall.percent + '%', 'accent'));
      var p = NET.progress.get();
      sum.appendChild(h('span', 'chip', 'лаб: ' + p.totals.labsSolved));
      sum.appendChild(h('span', 'chip', 'задач: ' + p.totals.tasksSolved));
      sum.appendChild(h('span', 'chip', 'стрик: ' + p.streak.days + ' дн.'));
    }
  }

  function renderSrs() {
    var box = document.getElementById('srs-list');
    if (!box) return;
    box.textContent = '';
    var due = NET.srs.due(8);
    var counter = document.getElementById('srs-count');
    if (counter) counter.textContent = String(NET.srs.dueCount());
    if (!due.length) {
      box.appendChild(h('div', 'empty', 'Нечего повторять — очередь пуста. ' +
        'Карточки появляются после ошибок и подсказок.'));
      return;
    }
    due.forEach(function (c) {
      var row = h('div', 'row');
      row.appendChild(h('span', c.lapses ? 'err' : 'warn', c.lapses ? '!' : '↻'));
      row.appendChild(h('span', 't', c.title));
      var skill = NET.skills.get(c.skill);
      row.appendChild(h('span', 'sub', skill ? skill.title.split(' ')[0] : c.skill));
      row.title = 'Повторение: ' + (skill ? skill.title : c.skill) +
        (c.lapses ? ' · ошибок ' + c.lapses : '');
      row.addEventListener('click', function () {
        var task = NET.taskPool.pick({ skill: c.skill });
        if (task) {
          NET.modes.set(task.type === 'command' ? 'trainer' : 'quick');
          NET.ui.labs.renderModes();
          NET.ui.task.quick.start(task.type);
        } else {
          NET.ui.notify.info('Нет короткой задачи', 'по этой теме есть только лабораторные');
        }
      });
      box.appendChild(row);
    });
  }

  function renderAll() {
    renderSkills();
    renderSrs();
    if (NET.ui.app) NET.ui.app.updateTopbar();
  }

  /* ---------- экспорт / импорт ---------- */

  function exportProfile() {
    NET.storage.exportAll().then(function (dump) {
      var blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'lnet-trainer-progress-' + NET.util.isoDate() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        document.body.removeChild(a);
      }, 100);
      NET.ui.notify.ok('Прогресс выгружен', 'JSON-файл сохранён в загрузки');
    });
  }

  function importProfile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var dump = JSON.parse(String(reader.result));
          NET.storage.importAll(dump).then(function () {
            return Promise.all([NET.progress.load(), NET.srs.load()]);
          }).then(function () {
            renderAll();
            NET.ui.labs.renderList();
            NET.ui.task.render();
            NET.ui.notify.ok('Прогресс загружен', 'Профиль восстановлен из файла');
          });
        } catch (e) {
          NET.ui.notify.err('Файл не прочитан', 'Ожидается JSON, выгруженный этим тренажёром');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function resetProfile() {
    if (!window.confirm('Сбросить весь прогресс: результаты лабораторий, навыки и очередь повторения?')) return;
    Promise.all([NET.progress.reset(), NET.srs.reset()]).then(function () {
      renderAll();
      NET.ui.labs.renderList();
      NET.ui.task.render();
      NET.ui.notify.warn('Прогресс сброшен', 'Профиль создан заново');
    });
  }

  NET.bus.on('progress:updated', renderAll);
  NET.bus.on('srs:updated', renderSrs);

  NET.ui.progress = {
    render: renderAll,
    renderSkills: renderSkills,
    renderSrs: renderSrs,
    exportProfile: exportProfile,
    importProfile: importProfile,
    resetProfile: resetProfile
  };
})(window.NET);
