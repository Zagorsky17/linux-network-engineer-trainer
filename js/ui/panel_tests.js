/*
 * panel_tests.js — каталог тестов по командам (вкладка «Тесты»).
 *
 * Тесты по темам живут отдельно от лабораторных: их проходят, чтобы закрепить
 * сами команды, а не сценарий поломки. Каталог собирается из данных
 * (NET.quiz.catalog()), поэтому новая тема появляется здесь сама, как только
 * её файл подключён — правки панели для этого не нужны.
 * Само прохождение рисует panel_quiz.js в этом же контейнере.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};
  var D = NET.ui.dom;
  var h = D.h;

  function root() { return document.getElementById('tab-tests'); }

  /* ---------- сводка по всем темам ---------- */

  function stats() {
    var ids = NET.quiz.topicIds();
    var done = 0, passed = 0, sum = 0;
    ids.forEach(function (id) {
      var res = NET.progress.quizResult(id);
      if (!res) return;
      done++;
      sum += res.best;
      if (res.best >= NET.quiz.PASS_PERCENT) passed++;
    });
    return {
      total: ids.length, done: done, passed: passed,
      average: done ? Math.round(sum / done) : 0
    };
  }

  /* ---------- карточка темы ---------- */

  function card(qz) {
    var res = NET.progress.quizResult(qz.id);
    var box = h('button', 'test-card' + (res && res.best >= NET.quiz.PASS_PERCENT ? ' done' : ''));

    var top = h('div', 'lesson-card-top');
    top.appendChild(h('span', 'lesson-card-title', qz.title));
    if (res) {
      top.appendChild(D.chip(res.best + '%', res.best >= NET.quiz.PASS_PERCENT ? 'ok' : 'warn'));
    }
    box.appendChild(top);

    box.appendChild(h('div', 'lesson-card-lead', qz.desc));

    var cmds = h('div', 'test-card-cmds');
    qz.commands.slice(0, 6).forEach(function (c) { cmds.appendChild(h('code', null, c)); });
    if (qz.commands.length > 6) cmds.appendChild(h('span', 'dim', '+' + (qz.commands.length - 6)));
    box.appendChild(cmds);

    var meta = h('div', 'lesson-card-meta');
    meta.appendChild(h('span', null, qz.questions.length + ' вопросов'));
    meta.appendChild(h('span', null, res ? 'попыток: ' + res.tries : 'ещё не проходили'));
    box.appendChild(meta);

    box.addEventListener('click', function () { open(qz.id); });
    return box;
  }

  /* ---------- каталог ---------- */

  function renderIndex() {
    var box = root();
    if (!box) return;
    if (NET.ui.quiz) NET.ui.quiz.close();
    box.textContent = '';
    box.scrollTop = 0;

    var head = h('div', 'lesson-head');
    head.appendChild(h('h2', 'lesson-title', 'Тесты по командам'));
    head.appendChild(h('p', 'lesson-lead',
      'Вопрос и варианты ответа: что показывает команда, каким ключом получить нужное и как прочитать результат. ' +
      'Верный ответ и объяснение появляются сразу после выбора, поэтому тест работает и как проверка, и как повторение. ' +
      'Темы независимы — проходить можно в любом порядке и сколько угодно раз.'));
    box.appendChild(head);

    var st = stats();
    var meta = h('div', 'lesson-meta');
    meta.appendChild(D.chip('тем: ' + st.total));
    meta.appendChild(D.chip('пройдено: ' + st.done, st.done ? 'ok' : ''));
    meta.appendChild(D.chip('зачётов: ' + st.passed, st.passed ? 'ok' : ''));
    if (st.done) meta.appendChild(D.chip('средний балл: ' + st.average + '%'));
    meta.appendChild(D.chip('зачёт от ' + NET.quiz.PASS_PERCENT + '%'));
    box.appendChild(meta);

    var actions = h('div', 'lesson-nav');
    actions.appendChild(D.button('Случайная тема', null, 'small', function () { random(); }));
    actions.appendChild(D.button('Незачёты и непройденные', null, 'small ghost', function () { weakest(); }));
    box.appendChild(actions);

    NET.quiz.catalog().forEach(function (group) {
      var sec = h('section', 'test-group');
      sec.appendChild(h('h3', 'lesson-h', group.title));
      if (group.desc) sec.appendChild(h('p', 'lesson-p dim', group.desc));
      var list = h('div', 'lesson-list');
      group.topics.forEach(function (qz) { list.appendChild(card(qz)); });
      sec.appendChild(list);
      box.appendChild(sec);
    });

    lessonTests(box);
  }

  /* Тесты к урокам остаются частью теории — здесь только ссылки на них. */
  function lessonTests(box) {
    var ids = NET.quiz.lessonIds();
    if (!ids.length) return;
    var sec = h('section', 'test-group');
    sec.appendChild(h('h3', 'lesson-h', 'Тесты к лабораторным'));
    sec.appendChild(h('p', 'lesson-p dim',
      'По одному на каждый урок: вопросы привязаны к разобранной в нём поломке. Откроются во вкладке «Теория».'));
    var list = h('div', 'list');
    ids.forEach(function (id) {
      var qz = NET.quiz.get(id);
      var res = NET.progress.quizResult(id);
      var row = h('div', 'row');
      row.appendChild(h('span', res && res.best >= NET.quiz.PASS_PERCENT ? 'done' : 'faint',
        res && res.best >= NET.quiz.PASS_PERCENT ? '✔' : '·'));
      row.appendChild(h('span', 't', qz.title));
      row.appendChild(h('span', 'sub', qz.questions.length + ' вопр.' +
        (res ? ' · лучший ' + res.best + '%' : '')));
      row.addEventListener('click', function () { NET.ui.quiz.show(id); });
      list.appendChild(row);
    });
    sec.appendChild(list);
    box.appendChild(sec);
  }

  /* ---------- открытие тестов ---------- */

  function open(id) {
    NET.ui.app.switchCenterTab('tests');
    return NET.ui.quiz.open(id, { host: 'tests' });
  }

  function random() {
    var ids = NET.quiz.topicIds();
    if (!ids.length) return null;
    return open(ids[Math.floor(Math.random() * ids.length)]);
  }

  /* Первая тема без зачёта: непройденные важнее уже сданных с низким баллом. */
  function weakest() {
    var ids = NET.quiz.topicIds();
    var fresh = null, weak = null, weakBest = 101;
    ids.forEach(function (id) {
      var res = NET.progress.quizResult(id);
      if (!res) { if (!fresh) fresh = id; return; }
      if (res.best < NET.quiz.PASS_PERCENT && res.best < weakBest) { weak = id; weakBest = res.best; }
    });
    var pick = fresh || weak;
    if (!pick) {
      NET.ui.notify.info('Все темы сданы', 'Зачёт получен по всем темам каталога. Можно пройти любую заново.');
      return null;
    }
    return open(pick);
  }

  /* Вызывается при переключении на вкладку: открытый тест не затираем. */
  function render() {
    if (NET.ui.quiz && NET.ui.quiz.state()) return;
    renderIndex();
  }

  NET.ui.tests = {
    root: root,
    render: render,
    renderIndex: renderIndex,
    open: open,
    random: random,
    weakest: weakest,
    stats: stats
  };
})(window.NET);
