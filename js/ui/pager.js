/*
 * pager.js — постраничный просмотр (less/man) и простой редактор файлов,
 * который нужен, чтобы править /etc/netplan прямо в тренажёре.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};

  /* ---------- pager ---------- */

  var pager = {
    open: function (text, title) {
      var overlay = document.getElementById('pager');
      var body = document.getElementById('pager-body');
      var head = document.getElementById('pager-title');
      head.textContent = title || 'less';
      body.textContent = text;
      overlay.classList.remove('hidden');
      body.scrollTop = 0;
      body.focus();
      pager._search = '';
      pager._active = true;
    },
    close: function () {
      document.getElementById('pager').classList.add('hidden');
      pager._active = false;
      if (NET.ui.terminal) NET.ui.terminal.focus();
    },
    active: function () { return !!pager._active; },
    key: function (e) {
      var body = document.getElementById('pager-body');
      if (e.key === 'q' || e.key === 'Escape') { pager.close(); e.preventDefault(); return; }
      if (e.key === ' ' || e.key === 'PageDown' || e.key === 'f') {
        body.scrollTop += body.clientHeight - 30; e.preventDefault(); return;
      }
      if (e.key === 'b' || e.key === 'PageUp') {
        body.scrollTop -= body.clientHeight - 30; e.preventDefault(); return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') { body.scrollTop += 24; e.preventDefault(); return; }
      if (e.key === 'k' || e.key === 'ArrowUp') { body.scrollTop -= 24; e.preventDefault(); return; }
      if (e.key === 'g') { body.scrollTop = 0; e.preventDefault(); return; }
      if (e.key === 'G') { body.scrollTop = body.scrollHeight; e.preventDefault(); return; }
      if (e.key === '/') {
        var term = window.prompt('Поиск в тексте:');
        if (!term) return;
        var text = body.textContent;
        var idx = text.indexOf(term);
        if (idx < 0) { NET.ui.notify.warn('Не найдено', term); return; }
        var before = text.slice(0, idx).split('\n').length;
        body.scrollTop = Math.max(0, (before - 3) * 19);
        e.preventDefault();
      }
    }
  };

  /* ---------- редактор ---------- */

  var editor = {
    path: null,
    user: null,
    open: function (path, content, user) {
      editor.path = path;
      editor.user = user;
      document.getElementById('editor-title').textContent = path +
        (user === 'root' ? '' : '  (открыт от ' + user + ' — для /etc нужен sudo)');
      var ta = document.getElementById('editor-text');
      ta.value = content;
      document.getElementById('editor').classList.remove('hidden');
      setTimeout(function () { ta.focus(); ta.setSelectionRange(0, 0); }, 10);
      editor._active = true;
    },
    close: function () {
      document.getElementById('editor').classList.add('hidden');
      editor._active = false;
      if (NET.ui.terminal) NET.ui.terminal.focus();
    },
    active: function () { return !!editor._active; },
    save: function () {
      var ta = document.getElementById('editor-text');
      var machine = NET.world.machine();
      var ctx = machine.users.ctx(editor.user);
      try {
        machine.vfs.write(editor.path, ta.value, ctx);
        NET.ui.notify.ok('Файл сохранён', editor.path);
        editor.close();
        if (NET.ui.terminal) {
          NET.ui.terminal.write('[записан ' + editor.path + ']\n', 'sys');
        }
      } catch (e) {
        NET.ui.notify.err('Не удалось сохранить', (e.message || 'ошибка') +
          (editor.user !== 'root' ? ' — попробуйте sudo nano ' + editor.path : ''));
      }
    }
  };

  NET.ui.pager = pager;
  NET.ui.editor = editor;
})(window.NET);
