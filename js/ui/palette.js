/*
 * palette.js — командная палитра (Ctrl+K): быстрый переход к лаборатории,
 * режиму, хосту или справке без отрыва от клавиатуры.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};
  var items = [];
  var filtered = [];
  var sel = 0;

  function build() {
    items = [];
    NET.labs.list().forEach(function (lab) {
      items.push({
        kind: 'Лаборатория', label: lab.id.toUpperCase() + ' · ' + lab.title,
        hint: '★'.repeat(lab.difficulty),
        run: function () { NET.ui.labs.start(lab.id); }
      });
    });
    NET.modes.list.forEach(function (m) {
      items.push({
        kind: 'Режим', label: m.title, hint: m.desc.slice(0, 60),
        run: function () { NET.ui.labs.selectMode(m.id); }
      });
    });
    if (NET.quiz && NET.quiz.catalog) {
      NET.quiz.catalog().forEach(function (g) {
        g.topics.forEach(function (qz) {
          items.push({
            kind: 'Тест', label: qz.title,
            hint: g.title + ' · ' + qz.questions.length + ' вопросов',
            run: function () { NET.ui.tests.open(qz.id); }
          });
        });
      });
    }
    NET.world.shells().forEach(function (m) {
      items.push({
        kind: 'Хост', label: 'connect ' + m.name, hint: m.hostname + ' ' + (m.net.primaryIP() || ''),
        run: function () { NET.ui.terminal.run('connect ' + m.name); }
      });
    });
    NET.man.names().forEach(function (n) {
      items.push({
        kind: 'Справка', label: 'man ' + n, hint: (NET.commands.get(n) || {}).summary || '',
        run: function () { NET.ui.terminal.run('man ' + n); }
      });
    });
    [['check', 'проверить решение'], ['hint', 'подсказка'], ['reset', 'сбросить лабораторию'],
      ['lab list', 'список лабораторий'], ['hosts', 'узлы топологии'], ['help', 'все команды'],
      ['quiz list', 'каталог тестов по командам'], ['quiz random', 'случайная тема теста'],
      ['selftest', 'самопроверка движка']].forEach(function (p) {
      items.push({
        kind: 'Тренажёр', label: p[0], hint: p[1],
        run: function () { NET.ui.terminal.run(p[0]); }
      });
    });
  }

  function open() {
    if (!items.length) build();
    var overlay = document.getElementById('palette');
    overlay.classList.remove('hidden');
    var input = document.getElementById('palette-input');
    input.value = '';
    filter('');
    input.focus();
  }

  function close() {
    document.getElementById('palette').classList.add('hidden');
    if (NET.ui.terminal) NET.ui.terminal.focus();
  }

  function active() {
    var o = document.getElementById('palette');
    return o && !o.classList.contains('hidden');
  }

  function filter(q) {
    q = (q || '').toLowerCase().trim();
    filtered = items.filter(function (it) {
      if (!q) return true;
      return (it.label + ' ' + it.kind + ' ' + (it.hint || '')).toLowerCase().indexOf(q) >= 0;
    }).slice(0, 40);
    sel = 0;
    renderList();
  }

  function renderList() {
    var box = document.getElementById('palette-results');
    box.textContent = '';
    filtered.forEach(function (it, i) {
      var row = document.createElement('div');
      row.className = 'row' + (i === sel ? ' active' : '');
      var k = document.createElement('span');
      k.className = 'k';
      k.textContent = it.kind;
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = it.label;
      var s = document.createElement('span');
      s.className = 'sub';
      s.textContent = it.hint || '';
      row.appendChild(k);
      row.appendChild(t);
      row.appendChild(s);
      row.addEventListener('click', function () { exec(i); });
      box.appendChild(row);
    });
    if (!filtered.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'Ничего не найдено';
      box.appendChild(e);
    }
  }

  function exec(i) {
    var it = filtered[i === undefined ? sel : i];
    close();
    if (it) setTimeout(it.run, 10);
  }

  function key(e) {
    if (e.key === 'Escape') { close(); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { sel = Math.min(filtered.length - 1, sel + 1); renderList(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderList(); e.preventDefault(); return; }
    if (e.key === 'Enter') { exec(); e.preventDefault(); return; }
  }

  NET.ui.palette = { open: open, close: close, active: active, filter: filter, key: key, rebuild: build };
})(window.NET);
