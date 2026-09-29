/*
 * panel_quiz.js — прохождение теста по командам.
 *
 * Одна и та же страница обслуживает два места: тест к уроку открывается
 * во вкладке «Теория» на месте урока, тест по теме — во вкладке «Тесты»
 * на месте каталога. Различие — только контейнер и кнопки возврата,
 * поэтому они вынесены в hosts.
 * Все вопросы на одной странице: вариант выбирается один раз, сразу
 * показывается верный ответ и объяснение — тест работает как тренажёр,
 * а не только как контроль. Варианты перемешиваются при каждом прохождении,
 * чтобы запоминался смысл, а не позиция ответа. Лучший результат
 * сохраняется в прогрессе.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};
  var D = NET.ui.dom;
  var h = D.h;

  var state = null;

  /* Где живёт тест: контейнер, подпись и возврат к списку. */
  var hosts = {
    lesson: {
      root: function () { return NET.ui.lesson.root(); },
      backLabel: '← К уроку',
      back: function (id) { NET.ui.lesson.open(id); },
      indexLabel: 'Все уроки',
      index: function () { NET.ui.lesson.renderIndex(); },
      tab: 'lesson'
    },
    tests: {
      root: function () { return NET.ui.tests.root(); },
      backLabel: '← Все тесты',
      back: function () { NET.ui.tests.renderIndex(); },
      indexLabel: 'Теория',
      index: function () { NET.ui.app.switchCenterTab('lesson'); NET.ui.lesson.renderIndex(); },
      tab: 'tests'
    }
  };

  function hostFor(id, name) {
    if (name && hosts[name]) return hosts[name];
    return NET.quiz.isTopic(id) && NET.ui.tests ? hosts.tests : hosts.lesson;
  }

  function shuffled(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(i);
    for (var j = a.length - 1; j > 0; j--) {
      var k = Math.floor(Math.random() * (j + 1));
      var t = a[j]; a[j] = a[k]; a[k] = t;
    }
    return a;
  }

  function answeredCount() {
    return state.answers.filter(function (a) { return a !== null; }).length;
  }

  function correctCount() {
    var qs = state.quiz.questions;
    return state.answers.filter(function (a, i) { return a === qs[i].answer; }).length;
  }

  function updateScore() {
    if (!state.scoreEl) return;
    state.scoreEl.textContent = 'Отвечено ' + answeredCount() + ' из ' + state.quiz.questions.length +
      ' · верно ' + correctCount();
  }

  function choose(qi, orig, buttons, explainEl) {
    if (state.answers[qi] !== null) return;
    var q = state.quiz.questions[qi];
    state.answers[qi] = orig;
    buttons.forEach(function (b) {
      b.disabled = true;
      var idx = Number(b.getAttribute('data-orig'));
      if (idx === q.answer) b.classList.add('right');
      else if (idx === orig) b.classList.add('wrong');
    });
    var ok = orig === q.answer;
    explainEl.textContent = '';
    explainEl.className = 'quiz-explain ' + (ok ? 'ok' : 'fail');
    explainEl.appendChild(h('b', null, ok ? 'Верно. ' : 'Неверно. Правильно: «' + q.options[q.answer] + '». '));
    explainEl.appendChild(D.text(q.explain));
    updateScore();
    if (answeredCount() === state.quiz.questions.length) finish();
  }

  function finish() {
    var res = NET.quiz.grade(state.quiz.id, state.answers);
    NET.progress.recordQuiz(state.quiz.id, res.percent);
    NET.bus.emit('quiz:finished', res);

    var box = state.resultEl;
    box.textContent = '';
    box.className = 'quiz-result ' + (res.passed ? 'ok' : 'fail');
    box.appendChild(h('div', 'quiz-result-score', res.percent + '%'));
    box.appendChild(h('div', null, (res.passed ? 'Зачёт. ' : 'Пока не зачёт (нужно от ' + NET.quiz.PASS_PERCENT + '%). ') +
      'Верно ' + res.correct + ' из ' + res.total + '.'));
    if (res.wrong.length) {
      box.appendChild(h('div', 'dim', 'Перечитайте объяснения к вопросам ' +
        res.wrong.map(function (i) { return i + 1; }).join(', ') +
        ' и раздел урока «Команды: что показывают и как читать результат».'));
    }
    var host = state.host;
    var id = state.quiz.id;
    var actions = h('div', 'lesson-nav inline');
    actions.appendChild(D.button('Пройти ещё раз', null, 'primary', function () { open(id, { host: host.tab }); }));
    actions.appendChild(D.button(host.backLabel, null, '', function () { host.back(id); }));
    var lesson = NET.lessons.get(id);
    if (lesson && lesson.lab) {
      actions.appendChild(D.button('Начать ' + lesson.lab.toUpperCase(), null, '', function () {
        NET.ui.labs.start(lesson.lab);
        NET.ui.app.switchCenterTab('terminal');
      }));
    }
    box.appendChild(actions);
  }

  function open(id, opts) {
    var quiz = NET.quiz.get(id);
    var host = hostFor(id, opts && opts.host);
    var box = host.root();
    if (!quiz || !box) return null;

    state = { quiz: quiz, host: host, answers: quiz.questions.map(function () { return null; }) };
    box.textContent = '';
    box.scrollTop = 0;

    var nav = h('div', 'lesson-nav');
    nav.appendChild(D.button(host.backLabel, null, 'small ghost', function () { host.back(id); }));
    nav.appendChild(D.button(host.indexLabel, null, 'small ghost', function () { host.index(); }));
    box.appendChild(nav);

    var article = h('article', 'lesson quiz');
    article.appendChild(h('h2', 'lesson-title', 'Тест по командам'));
    article.appendChild(h('p', 'lesson-lead', quiz.title));
    if (quiz.desc) article.appendChild(h('p', 'lesson-p dim', quiz.desc));
    var meta = h('div', 'lesson-meta');
    meta.appendChild(D.chip(quiz.questions.length + ' вопросов'));
    meta.appendChild(D.chip('зачёт от ' + quiz.passPercent + '%'));
    var prev = NET.progress.quizResult(id);
    if (prev) meta.appendChild(D.chip('лучший: ' + prev.best + '%', prev.best >= quiz.passPercent ? 'ok' : 'warn'));
    article.appendChild(meta);

    state.scoreEl = h('div', 'quiz-score');
    article.appendChild(state.scoreEl);
    updateScore();

    quiz.questions.forEach(function (q, qi) {
      var card = h('div', 'quiz-q');
      var head = h('div', 'quiz-q-head');
      head.appendChild(h('span', 'quiz-q-num', String(qi + 1)));
      head.appendChild(h('span', 'quiz-q-text', q.q));
      head.appendChild(h('code', 'quiz-q-cmd', q.cmd));
      card.appendChild(head);

      var explain = h('div', 'quiz-explain');
      var opts = h('div', 'quiz-opts');
      var buttons = [];
      shuffled(q.options.length).forEach(function (orig) {
        var b = h('button', 'quiz-opt', q.options[orig]);
        b.setAttribute('data-orig', String(orig));
        b.addEventListener('click', function () { choose(qi, orig, buttons, explain); });
        buttons.push(b);
        opts.appendChild(b);
      });
      card.appendChild(opts);
      card.appendChild(explain);
      article.appendChild(card);
    });

    state.resultEl = h('div', 'quiz-result');
    article.appendChild(state.resultEl);
    box.appendChild(article);
    NET.bus.emit('quiz:opened', { id: id });
    return quiz;
  }

  /* Открыть тест вместе с переключением вкладки — для команды quiz и кнопок. */
  function show(id) {
    var host = hostFor(id);
    NET.ui.app.switchCenterTab(host.tab);
    return open(id, { host: host.tab });
  }

  /* Где откроется тест: подсказка для команды quiz. */
  function tabOf(id) { return hostFor(id).tab; }

  NET.ui.quiz = {
    open: open,
    show: show,
    tabOf: tabOf,
    state: function () { return state; },
    close: function () { state = null; }
  };
})(window.NET);
