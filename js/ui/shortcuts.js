/*
 * shortcuts.js — глобальные горячие клавиши.
 * Терминал остаётся в фокусе, поэтому перехватываем только сочетания
 * с модификаторами, функциональные клавиши и «?» вне поля ввода.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};

  var LIST = [
    ['F1', 'фокус в терминал'],
    ['Ctrl/⌘ + Enter', 'проверить решение (check)'],
    ['F2', 'подсказка (hint)'],
    ['F5', 'сбросить лабораторию'],
    ['Ctrl/⌘ + K', 'командная палитра'],
    ['Alt + 1 / 2 / 3', 'терминал / схема топологии / теория'],
    ['Alt + T', 'тесты по командам'],
    ['Alt + 4 / 5 / 6', 'задание / разбор / история'],
    ['Alt + Q', 'быстрая задача (Quick Practice)'],
    ['Ctrl + L', 'очистить терминал'],
    ['Ctrl + C', 'прервать выполнение'],
    ['Ctrl + R', 'поиск по истории команд'],
    ['Ctrl + U / K / W', 'стереть до начала / до конца / слово'],
    ['Ctrl + A / E', 'в начало / в конец строки'],
    ['↑ / ↓', 'история команд'],
    ['Tab / Tab Tab', 'автодополнение / список вариантов'],
    ['?', 'это окно'],
    ['Esc', 'закрыть оверлей']
  ];

  function isTyping(e) {
    var t = e.target;
    if (!t) return false;
    var tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select';
  }

  function showHelp() {
    var overlay = document.getElementById('help-overlay');
    var body = document.getElementById('help-body');
    body.textContent = '';
    var grid = document.createElement('div');
    grid.className = 'kbd-grid';
    LIST.forEach(function (row) {
      var k = document.createElement('kbd');
      k.textContent = row[0];
      var d = document.createElement('div');
      d.className = 'd';
      d.textContent = row[1];
      grid.appendChild(k);
      grid.appendChild(d);
    });
    body.appendChild(grid);
    overlay.classList.remove('hidden');
  }

  function hideOverlays() {
    ['help-overlay', 'palette', 'pager', 'editor'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    if (NET.ui.terminal) NET.ui.terminal.focus();
  }

  function init() {
    document.addEventListener('keydown', function (e) {
      var ctrl = e.ctrlKey || e.metaKey;

      if (NET.ui.palette.active()) { NET.ui.palette.key(e); return; }
      if (NET.ui.pager.active() && !isTyping(e)) { NET.ui.pager.key(e); return; }
      if (NET.ui.editor.active()) {
        if (ctrl && (e.key === 's' || e.key === 'S' || e.key === 'Enter')) {
          NET.ui.editor.save();
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape') { NET.ui.editor.close(); e.preventDefault(); return; }
        return;
      }

      if (e.key === 'Escape') { hideOverlays(); return; }

      /* прервать выполняющуюся команду, даже если фокус ушёл из терминала */
      if (ctrl && (e.key === 'c' || e.key === 'C') && NET.ui.terminal.busy() && !isTyping(e)) {
        var sel = window.getSelection ? String(window.getSelection()) : '';
        if (!sel) {
          NET.ui.app.session().aborted = true;
          NET.ui.terminal.write('^C\n', 'stderr');
          e.preventDefault();
          return;
        }
      }
      if (ctrl && (e.key === 'k' || e.key === 'K')) {
        NET.ui.palette.open();
        e.preventDefault();
        return;
      }
      if (ctrl && e.key === 'Enter') {
        NET.ui.labs.check();
        e.preventDefault();
        return;
      }
      if (e.key === 'F1') { NET.ui.terminal.focus(); e.preventDefault(); return; }
      if (e.key === 'F2') { NET.ui.labs.hint(); e.preventDefault(); return; }
      if (e.key === 'F5') { NET.ui.labs.reset(); e.preventDefault(); return; }

      if (e.altKey && !ctrl) {
        var map = {
          '1': ['center', 'terminal'], '2': ['center', 'topology'], '3': ['center', 'lesson'],
          '4': ['right', 'task'], '5': ['right', 'debrief'], '6': ['right', 'history']
        };
        if (map[e.key]) {
          var t = map[e.key];
          if (t[0] === 'center') NET.ui.app.switchCenterTab(t[1]);
          else NET.ui.app.switchRightTab(t[1]);
          e.preventDefault();
          return;
        }
        if (e.key === 't' || e.key === 'T') {
          NET.ui.app.switchCenterTab('tests');
          e.preventDefault();
          return;
        }
        if (e.key === 'q' || e.key === 'Q') {
          NET.modes.set('quick');
          NET.ui.labs.renderModes();
          NET.ui.task.quick.start('state');
          e.preventDefault();
          return;
        }
      }

      if (e.key === '?' && !isTyping(e)) { showHelp(); e.preventDefault(); return; }
      if (ctrl && (e.key === 'l' || e.key === 'L') && !isTyping(e)) {
        NET.ui.terminal.clear();
        e.preventDefault();
      }
    });
  }

  NET.ui.shortcuts = { init: init, showHelp: showHelp, list: LIST };
})(window.NET);
