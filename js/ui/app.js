/*
 * app.js — сборка приложения: загрузка профиля, создание мира, инициализация
 * терминала и панелей, верхняя строка состояния.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};
  var session = null;
  var timerId = null;
  var booted = false;

  function byId(id) { return document.getElementById(id); }

  /* ---------- вкладки ---------- */

  function switchTabs(groupSel, paneIds, active) {
    var group = document.querySelector(groupSel);
    if (group) {
      Array.prototype.forEach.call(group.querySelectorAll('button[data-tab]'), function (b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === active);
      });
    }
    paneIds.forEach(function (id) {
      var pane = byId('tab-' + id);
      if (pane) pane.classList.toggle('active', id === active);
    });
  }

  function switchCenterTab(name) {
    switchTabs('#center-tabs', ['terminal', 'topology', 'lesson'], name);
    if (name === 'topology') NET.ui.topology.render();
    if (name === 'lesson') NET.ui.lesson.render();
    if (name === 'terminal') NET.ui.terminal.focus();
  }

  function switchRightTab(name) {
    switchTabs('#right-tabs', ['task', 'debrief', 'history'], name);
    if (name === 'task') NET.ui.task.render();
    if (name === 'debrief') NET.ui.debrief.render();
    if (name === 'history') NET.ui.history.render();
  }

  /* ---------- верхняя строка ---------- */

  function updateTopbar() {
    var overall = NET.progress.overall();
    var p = NET.progress.get();

    var lvl = byId('level-chip');
    if (lvl) {
      lvl.textContent = '';
      lvl.appendChild(NET.ui.dom.h('span', 'level-dot level-' + overall.level.id));
      lvl.appendChild(NET.ui.dom.text(' ' + overall.level.title + ' · ' + overall.percent + '%'));
      lvl.title = 'Общий уровень считается по результатам лабораторий: охват тем ' +
        Math.round(overall.coverage * 100) + '%' +
        (overall.level.next ? ', до ' + overall.level.next + ': +' + overall.level.toNext + '%' : '');
    }

    var streak = byId('streak-chip');
    if (streak) streak.textContent = '🔥 ' + p.streak.days + ' дн.';

    var due = byId('due-chip');
    if (due) {
      var n = NET.srs.dueCount();
      due.textContent = 'к повторению: ' + n;
      due.className = 'chip' + (n ? ' warn' : '');
    }

    var modeSel = byId('mode-select');
    if (modeSel && modeSel.value !== NET.modes.current()) modeSel.value = NET.modes.current();

    var hostSel = byId('host-select');
    if (hostSel) {
      var want = NET.world.current;
      if (hostSel.value !== want) hostSel.value = want;
    }

    var labChip = byId('lab-chip');
    var cur = NET.labs.current();
    if (labChip) {
      if (cur) {
        labChip.classList.remove('hidden');
        labChip.textContent = cur.lab.id.toUpperCase() + ' · ' + cur.lab.title;
      } else if (NET.ui.task.quick.task) {
        labChip.classList.remove('hidden');
        labChip.textContent = NET.modes.get().title;
      } else {
        labChip.classList.add('hidden');
      }
    }
  }

  function tick() {
    var cur = NET.labs.current();
    var t = byId('timer-chip');
    if (!t) return;
    var started = cur ? cur.startedAt : (NET.ui.task.quick.task ? NET.ui.task.quick.startedAt : 0);
    if (!started) { t.classList.add('hidden'); return; }
    var sec = Math.floor((Date.now() - started) / 1000);
    t.classList.remove('hidden');
    t.textContent = '⏱ ' + Math.floor(sec / 60) + ':' + NET.util.pad2(sec % 60);
  }

  /* ---------- привязка элементов ---------- */

  function wire() {
    byId('center-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]');
      if (b) switchCenterTab(b.getAttribute('data-tab'));
    });
    byId('right-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tab]');
      if (b) switchRightTab(b.getAttribute('data-tab'));
    });

    var modeSel = byId('mode-select');
    NET.modes.list.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.title;
      modeSel.appendChild(o);
    });
    modeSel.value = NET.modes.current();
    modeSel.addEventListener('change', function () { NET.ui.labs.selectMode(modeSel.value); });

    var hostSel = byId('host-select');
    NET.world.shells().forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.name;
      o.textContent = m.name + ' (' + m.hostname + ')';
      hostSel.appendChild(o);
    });
    hostSel.value = NET.world.current;
    hostSel.addEventListener('change', function () {
      NET.world.setCurrent(hostSel.value);
      NET.ui.terminal.write('[переключение на ' + NET.world.machine().hostname + ']\n', 'sys');
      NET.ui.terminal.refreshPrompt();
      NET.ui.terminal.focus();
      NET.ui.topology.render();
    });

    byId('btn-help').addEventListener('click', function () { NET.ui.shortcuts.showHelp(); });
    byId('btn-palette').addEventListener('click', function () { NET.ui.palette.open(); });
    byId('btn-export').addEventListener('click', function () { NET.ui.progress.exportProfile(); });
    byId('btn-import').addEventListener('click', function () { NET.ui.progress.importProfile(); });
    byId('btn-reset-progress').addEventListener('click', function () { NET.ui.progress.resetProfile(); });
    byId('btn-check').addEventListener('click', function () { NET.ui.labs.check(); });
    byId('btn-hint').addEventListener('click', function () { NET.ui.labs.hint(); });
    byId('btn-lab-reset').addEventListener('click', function () { NET.ui.labs.reset(); });
    byId('btn-random').addEventListener('click', function () {
      NET.modes.set('incident');
      NET.ui.labs.renderModes();
      NET.ui.labs.startRandom();
    });
    byId('btn-topo-refresh').addEventListener('click', function () { NET.ui.topology.render(); });

    byId('pager-close').addEventListener('click', function () { NET.ui.pager.close(); });
    byId('editor-save').addEventListener('click', function () { NET.ui.editor.save(); });
    byId('editor-cancel').addEventListener('click', function () { NET.ui.editor.close(); });
    byId('help-close').addEventListener('click', function () {
      byId('help-overlay').classList.add('hidden');
    });
    byId('palette-input').addEventListener('input', function (e) {
      NET.ui.palette.filter(e.target.value);
    });

    /* панели на узких экранах */
    byId('btn-toggle-left').addEventListener('click', function () {
      byId('left').classList.toggle('forced');
    });
    byId('btn-toggle-right').addEventListener('click', function () {
      byId('right').classList.toggle('forced');
    });

    document.querySelectorAll('.overlay').forEach(function (o) {
      o.addEventListener('mousedown', function (e) {
        if (e.target === o) o.classList.add('hidden');
      });
    });
  }

  /* ---------- запуск ---------- */

  /* Повторный вызов безопасен: точка входа срабатывает и по DOMContentLoaded,
     и вручную (например, из тестов интерфейса). */
  function boot() {
    if (booted) return Promise.resolve(false);
    booted = true;
    NET.errors.install();
    return NET.storage.init()
      .then(function () {
        return Promise.all([NET.progress.load(), NET.srs.load(), NET.modes.load()]);
      })
      .then(function () {
        NET.createWorld('campus');
        session = NET.shell.createSession(NET.world);
        NET.session = session;

        wire();
        NET.ui.terminal.init(session);
        NET.ui.labs.renderList();
        NET.ui.labs.renderModes();
        NET.ui.progress.render();
        NET.ui.task.render();
        NET.ui.debrief.render();
        NET.ui.topology.render();
        NET.ui.lesson.renderIndex();
        NET.ui.shortcuts.init();
        updateTopbar();

        var storageChip = byId('storage-chip');
        storageChip.textContent = NET.storage.describe();
        if (NET.storage.mode === 'memory') {
          storageChip.className = 'chip err';
          NET.ui.notify.warn('Хранилище недоступно',
            'Прогресс не сохранится после перезагрузки страницы. Выгрузите профиль кнопкой «Экспорт».');
        } else if (NET.storage.mode === 'local') {
          storageChip.className = 'chip warn';
        }

        /* сообщения хранилища видны пользователю, а не только в консоли */
        NET.bus.on('storage:full', function () {
          NET.ui.notify.err('Хранилище переполнено',
            'Прогресс больше не сохраняется. Выгрузите профиль кнопкой «Экспорт» и очистите данные сайта.');
        });
        NET.bus.on('storage:repaired', function (ev) {
          NET.ui.notify.warn('Сохранение было повреждено',
            'Раздел «' + ev.kind + '»: восстановлено значениями по умолчанию (' + ev.repaired.length + ' полей).');
        });
        NET.bus.on('storage:migrated', function (ev) {
          NET.ui.notify.info('Прогресс перенесён', 'Схема хранения обновлена: v' + ev.from + ' → v' + ev.to + '.');
        });
        NET.bus.on('progress:updated', updateTopbar);
        NET.bus.on('lab:started', updateTopbar);
        NET.bus.on('quick:started', updateTopbar);
        NET.bus.on('world:host-changed', function () {
          updateTopbar();
          NET.ui.terminal.refreshPrompt();
        });
        NET.bus.on('terminal:done', function () {
          NET.ui.task.render();
          if (byId('tab-topology').classList.contains('active')) NET.ui.topology.render();
        });

        timerId = setInterval(tick, 1000);
        /* вкладку закрывают или прячут — не держим таймер и досохраняем прогресс */
        if (window.addEventListener) {
          window.addEventListener('pagehide', shutdown);
          window.addEventListener('beforeunload', shutdown);
        }
        NET.boot();

        if (/[?&]selftest=1/.test(location.search)) {
          setTimeout(function () { NET.ui.terminal.run('selftest -v'); }, 300);
        }
        return true;
      })
      .catch(function (e) {
        NET.errors.report(e, 'app.boot');
        var out = byId('term-out');
        if (out) {
          out.textContent = 'Ошибка запуска: ' + NET.errors.describe(e) +
            '\nОткройте консоль браузера (F12) — там подробности.';
        }
      });
  }

  function shutdown() {
    if (timerId) { clearInterval(timerId); timerId = null; }
    if (NET.progress) NET.progress.save();
  }

  /* Точка входа: раньше это был инлайн-скрипт в index.html, из-за которого
     нельзя было включить строгую CSP без 'unsafe-inline'. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { boot(); });
  } else {
    setTimeout(boot, 0);
  }

  NET.ui.app = {
    boot: boot,
    shutdown: shutdown,
    switchCenterTab: switchCenterTab,
    switchRightTab: switchRightTab,
    updateTopbar: updateTopbar,
    session: function () { return session; }
  };
})(window.NET);
