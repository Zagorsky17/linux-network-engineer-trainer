/*
 * panel_lesson.js — читалка теории.
 *
 * Уроки занимают всю ширину центральной колонки: длинный текст в узкой панели
 * не читается. Пока урок открыт, терминал никуда не девается — вкладки
 * переключаются мгновенно, поэтому теорию можно листать прямо во время работы
 * над лабораторной.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};
  var D = NET.ui.dom;
  var h = D.h;

  var currentId = null;

  function root() { return document.getElementById('tab-lesson'); }

  /* Время урока: теория плюс методическая часть, если она есть. */
  function totalMinutes(lesson) {
    var m = NET.method ? NET.method.get(lesson.id) : null;
    return lesson.minutes + (m ? m.minutes : 0);
  }

  /* ---------- список уроков ---------- */

  function renderIndex() {
    var box = root();
    if (!box) return;
    if (NET.ui.quiz) NET.ui.quiz.close();
    box.textContent = '';
    currentId = null;

    var head = h('div', 'lesson-head');
    head.appendChild(h('h2', 'lesson-title', 'Теория'));
    head.appendChild(h('p', 'lesson-lead',
      'Каждая лабораторная опирается на свой урок. Урок объясняет предмет связным текстом: ' +
      'как это устроено, какие команды применяют, какие симптомы что означают и где обычно ' +
      'ошибаются. Читать можно до практики или во время неё — терминал остаётся на соседней вкладке.'));
    box.appendChild(head);

    var list = h('div', 'lesson-list');
    NET.lessons.list().forEach(function (l) {
      var card = h('button', 'lesson-card');
      var top = h('div', 'lesson-card-top');
      top.appendChild(h('span', 'lesson-card-title', l.title));
      if (NET.progress.isLessonRead(l.id)) top.appendChild(h('span', 'ok', '✔'));
      card.appendChild(top);

      var meta = h('div', 'lesson-card-meta');
      var skill = NET.skills.get(l.skill);
      meta.appendChild(h('span', null, (l.lab ? l.lab.toUpperCase() + ' · ' : 'Вводный урок · ') +
        (skill ? skill.title : l.skill)));
      var qr = NET.progress.quizResult(l.id);
      meta.appendChild(h('span', null, '~' + totalMinutes(l) + ' мин' + (qr ? ' · тест ' + qr.best + '%' : '')));
      card.appendChild(meta);

      card.appendChild(h('div', 'lesson-card-lead', l.lead));
      card.addEventListener('click', function () { open(l.id); });
      list.appendChild(card);
    });
    box.appendChild(list);
  }

  /* ---------- отрисовка урока ---------- */

  function commandTable(cmds) {
    var table = h('div', 'cmd-table');
    cmds.forEach(function (pair) {
      var row = h('div', 'c');
      row.appendChild(h('code', null, pair[0]));
      row.appendChild(h('span', null, pair[1] || ''));
      table.appendChild(row);
    });
    return table;
  }

  /* ---------- методическая часть (js/learn/method.js) ---------- */

  /* Раскрывающийся блок: решение и ответы не должны попадаться на глаза раньше времени. */
  function reveal(label, cls, build, isOpen) {
    var box = h('details', 'lesson-reveal' + (cls ? ' ' + cls : ''));
    if (isOpen) box.open = true;
    box.appendChild(h('summary', null, label));
    var body = h('div', 'lesson-reveal-body');
    build(body);
    box.appendChild(body);
    return box;
  }

  /* Для уроков раздела «Безопасность» показывается алгоритм реакции на атаку. */
  function algorithm(article, open, lessonId) {
    var U = NET.method.playbookFor ? NET.method.playbookFor(lessonId) : NET.method.universal;
    article.appendChild(h('h3', 'lesson-h', U.title));
    article.appendChild(reveal('Шаги от базовых проверок к глубоким (' + U.steps.length + ')', 'algo', function (body) {
      U.intro.forEach(function (t) { body.appendChild(h('p', 'lesson-p', t)); });
      U.steps.forEach(function (st) {
        var step = h('div', 'algo-step');
        var head = h('div', 'algo-head');
        head.appendChild(h('b', null, st.layer));
        head.appendChild(D.text(' — ' + st.q));
        step.appendChild(head);
        var cmds = h('div', 'algo-cmds');
        st.cmds.forEach(function (c) { cmds.appendChild(h('code', null, c)); });
        step.appendChild(cmds);
        var yes = h('div', 'algo-row ok');
        yes.appendChild(h('span', 'algo-mark', 'да'));
        yes.appendChild(h('span', null, st.pass));
        step.appendChild(yes);
        var no = h('div', 'algo-row fail');
        no.appendChild(h('span', 'algo-mark', 'нет'));
        no.appendChild(h('span', null, st.fail));
        step.appendChild(no);
        body.appendChild(step);
      });
      body.appendChild(h('div', 'lesson-sub', 'Принципы'));
      var ul = h('ul', 'lesson-list-ul');
      U.principles.forEach(function (t) { ul.appendChild(h('li', null, t)); });
      body.appendChild(ul);
      body.appendChild(h('div', 'lesson-sub', 'Словарь симптомов: сообщение → где проблема → чем проверить'));
      var table = h('div', 'symptom-table');
      U.symptoms.forEach(function (row) {
        var r = h('div', 'symptom-row');
        r.appendChild(h('code', null, row[0]));
        r.appendChild(h('span', null, row[1]));
        r.appendChild(h('span', 'dim', row[2]));
        table.appendChild(r);
      });
      body.appendChild(table);
    }, open));
  }

  function commandGuide(article, m) {
    article.appendChild(h('h3', 'lesson-h', 'Команды: что показывают и как читать результат'));
    m.commands.forEach(function (c) {
      var card = h('div', 'cmd-card');
      card.appendChild(h('code', 'cmd-card-cmd', c.cmd));
      var what = h('p', 'lesson-p');
      what.appendChild(h('b', null, 'Что показывает. '));
      what.appendChild(D.text(c.shows));
      card.appendChild(what);
      var why = h('p', 'lesson-p');
      why.appendChild(h('b', null, 'Зачем. '));
      why.appendChild(D.text(c.why));
      card.appendChild(why);
      var read = h('div', 'read-table');
      c.read.forEach(function (row) {
        var r = h('div', 'read-row');
        r.appendChild(h('code', null, row[0]));
        r.appendChild(h('span', null, '→ ' + row[1]));
        read.appendChild(r);
      });
      card.appendChild(read);
      article.appendChild(card);
    });
  }

  function scenario(article, sc) {
    article.appendChild(h('h3', 'lesson-h', 'Разбор похожего случая: ' + sc.title));
    article.appendChild(h('p', 'lesson-p dim',
      'Случай не совпадает с поломкой в лабораторной — важен ход рассуждения: ' +
      'симптом → гипотезы → проверки → локализация → исправление → повторная проверка.'));

    var flow = h('div', 'scenario');
    function stage(n, title) {
      var st = h('div', 'scenario-stage');
      st.appendChild(h('div', 'scenario-title', n + '. ' + title));
      flow.appendChild(st);
      return st;
    }
    stage(1, 'Симптом').appendChild(h('p', 'lesson-p', sc.symptom));

    var hyp = h('ol', 'lesson-list-ul');
    sc.hypotheses.forEach(function (t) { hyp.appendChild(h('li', null, t)); });
    stage(2, 'Гипотезы').appendChild(hyp);

    var checks = h('div', 'check-table');
    sc.checks.forEach(function (row) {
      var r = h('div', 'check-row');
      r.appendChild(h('code', null, row[0]));
      r.appendChild(h('span', 'check-res', row[1]));
      r.appendChild(h('span', null, row[2]));
      checks.appendChild(r);
    });
    stage(3, 'Проверки: команда → результат → вывод').appendChild(checks);

    flow.appendChild(reveal('4–6. Локализация, исправление и повторная проверка — сначала назовите причину сами', '', function (body) {
      body.appendChild(h('div', 'scenario-title', 'Локализация'));
      body.appendChild(h('p', 'lesson-p', sc.localize));
      body.appendChild(h('div', 'scenario-title', 'Исправление'));
      body.appendChild(commandTable(sc.fix));
      body.appendChild(h('div', 'scenario-title', 'Повторная проверка'));
      var v = h('ul', 'lesson-list-ul');
      sc.verify.forEach(function (t) { v.appendChild(h('li', null, t)); });
      body.appendChild(v);
      var note = h('div', 'lesson-note');
      note.appendChild(h('b', null, 'Перенос на другие задачи. '));
      note.appendChild(D.text(sc.transfer));
      body.appendChild(note);
    }));
    article.appendChild(flow);
  }

  function practice(article, lesson, m) {
    article.appendChild(h('h3', 'lesson-h', 'Практика на стенде'));
    article.appendChild(h('p', 'lesson-p',
      'Запустите ' + (lesson.lab ? lesson.lab.toUpperCase() : 'лабораторную') + ' и выполняйте команды по порядку. ' +
      'После каждой сравните вывод с ожидаемым и ответьте на вопрос — вслух или письменно — до того, ' +
      'как перейти к следующей. Решение скрыто ниже: откройте его, только когда назовёте причину сами.'));
    var ol = h('ol', 'practice-steps');
    m.practice.forEach(function (st) {
      var li = h('li', 'practice-step');
      li.appendChild(h('code', 'cmd-card-cmd', st.cmd));
      var exp = h('div', 'practice-row');
      exp.appendChild(h('b', null, 'Ожидаемо: '));
      exp.appendChild(D.text(st.expect));
      li.appendChild(exp);
      var ask = h('div', 'practice-row ask');
      ask.appendChild(h('b', null, 'Вопрос: '));
      ask.appendChild(D.text(st.ask));
      li.appendChild(ask);
      ol.appendChild(li);
    });
    article.appendChild(ol);

    article.appendChild(reveal('Показать решение и проверку', 'solution', function (body) {
      m.solution.steps.forEach(function (st) {
        var row = h('div', 'cmd-table');
        var c = h('div', 'c');
        c.appendChild(h('code', null, st.cmd));
        c.appendChild(h('span', null, st.note || ''));
        row.appendChild(c);
        body.appendChild(row);
        if (st.out) body.appendChild(h('pre', 'lesson-out', st.out));
      });
      body.appendChild(h('div', 'scenario-title', 'Как убедиться, что исправлено'));
      var v = h('div', 'read-table');
      m.solution.verify.forEach(function (st) {
        var r = h('div', 'read-row');
        r.appendChild(h('code', null, st.cmd));
        r.appendChild(h('span', null, st.sees ? '→ в выводе есть «' + st.sees.trim() + '»'
          : '→ в выводе нет «' + st.absent + '»'));
        v.appendChild(r);
      });
      body.appendChild(v);
    }));
  }

  function checklist(article, m) {
    article.appendChild(h('h3', 'lesson-h', 'Чек-лист диагностики'));
    var ul = h('ul', 'lesson-checklist');
    m.checklist.forEach(function (t) { ul.appendChild(h('li', null, t)); });
    article.appendChild(ul);
  }

  function questions(article, m) {
    article.appendChild(h('h3', 'lesson-h', 'Контрольные вопросы'));
    article.appendChild(h('p', 'lesson-p dim', 'Ответьте своими словами, затем раскройте ответ и сравните.'));
    m.questions.forEach(function (qa, i) {
      article.appendChild(reveal((i + 1) + '. ' + qa.q, 'qa', function (body) {
        body.appendChild(h('p', 'lesson-p', qa.a));
      }));
    });
  }

  function quizCall(article, lesson) {
    if (!NET.quiz || !NET.quiz.has(lesson.id)) return;
    var qz = NET.quiz.get(lesson.id);
    var box = h('div', 'lesson-quiz-call');
    var text = h('div');
    text.appendChild(h('b', null, 'Тест по командам. '));
    text.appendChild(D.text(qz.questions.length + ' вопросов о командах этого урока, зачёт от ' +
      qz.passPercent + '%. '));
    var res = NET.progress.quizResult(lesson.id);
    text.appendChild(D.text(res ? 'Лучший результат: ' + res.best + '% (попыток: ' + res.tries + ').'
      : 'Вы ещё не проходили тест.'));
    box.appendChild(text);
    box.appendChild(D.button('Пройти тест', null, 'primary', function () { NET.ui.quiz.open(lesson.id); }));
    article.appendChild(box);
  }

  function open(id) {
    var lesson = NET.lessons.get(id);
    var box = root();
    if (!lesson || !box) return null;
    if (NET.ui.quiz) NET.ui.quiz.close();
    currentId = id;
    box.textContent = '';
    box.scrollTop = 0;

    var nav = h('div', 'lesson-nav');
    nav.appendChild(D.button('← Все уроки', null, 'small ghost', function () { renderIndex(); }));
    if (lesson.lab) {
      nav.appendChild(D.button('Перейти к ' + lesson.lab.toUpperCase(), null, 'small primary', function () {
        NET.ui.labs.start(lesson.lab);
        NET.ui.app.switchCenterTab('terminal');
      }));
    }
    if (NET.quiz && NET.quiz.has(lesson.id)) {
      nav.appendChild(D.button('Тест по командам', null, 'small', function () { NET.ui.quiz.open(lesson.id); }));
    }
    nav.appendChild(D.button('Отметить прочитанным', null, 'small', function () {
      NET.progress.markLessonRead(lesson.id);
      NET.ui.notify.ok('Урок отмечен прочитанным', lesson.title);
      open(lesson.id);
    }));
    box.appendChild(nav);

    var article = h('article', 'lesson');
    article.appendChild(h('h2', 'lesson-title', lesson.title));

    var meta = h('div', 'lesson-meta');
    var skill = NET.skills.get(lesson.skill);
    meta.appendChild(D.chip((lesson.lab ? lesson.lab.toUpperCase() : 'Вводный урок')));
    if (skill) meta.appendChild(D.chip(skill.title));
    meta.appendChild(D.chip('~' + totalMinutes(lesson) + ' мин'));
    if (NET.progress.isLessonRead(lesson.id)) meta.appendChild(D.chip('прочитано', 'ok'));
    var qres = NET.progress.quizResult(lesson.id);
    if (qres) meta.appendChild(D.chip('тест: ' + qres.best + '%', qres.best >= NET.quiz.PASS_PERCENT ? 'ok' : 'warn'));
    article.appendChild(meta);

    article.appendChild(h('p', 'lesson-lead', lesson.lead));

    var m = NET.method ? NET.method.get(lesson.id) : null;

    lesson.sections.forEach(function (sec) {
      article.appendChild(h('h3', 'lesson-h', sec.h));
      (sec.p || []).forEach(function (para) {
        article.appendChild(h('p', 'lesson-p', para));
      });
      if (sec.out) article.appendChild(h('pre', 'lesson-out', sec.out));
      if (sec.cmds) article.appendChild(commandTable(sec.cmds));
      if (sec.note) {
        var note = h('div', 'lesson-note');
        note.appendChild(h('b', null, 'Важно. '));
        note.appendChild(D.text(sec.note));
        article.appendChild(note);
      }
    });

    if (m) {
      algorithm(article, lesson.id === 'lab01' || lesson.id === 'sec01', lesson.id);
      commandGuide(article, m);
      scenario(article, m.scenario);
    }

    if (lesson.pitfalls && lesson.pitfalls.length) {
      article.appendChild(h('h3', 'lesson-h', 'Типичные ошибки'));
      var ul = h('ul', 'lesson-list-ul');
      lesson.pitfalls.forEach(function (t) { ul.appendChild(h('li', null, t)); });
      article.appendChild(ul);
    }

    if (lesson.summary && lesson.summary.length) {
      article.appendChild(h('h3', 'lesson-h', 'Коротко'));
      var sum = h('ul', 'lesson-list-ul lesson-summary');
      lesson.summary.forEach(function (t) { sum.appendChild(h('li', null, t)); });
      article.appendChild(sum);
    }

    if (m) {
      practice(article, lesson, m);
      checklist(article, m);
      questions(article, m);
    }
    quizCall(article, lesson);

    if (lesson.practice) {
      var toPractice = h('div', 'lesson-practice');
      toPractice.appendChild(h('b', null, 'К практике. '));
      toPractice.appendChild(D.text(lesson.practice));
      article.appendChild(toPractice);
    }

    box.appendChild(article);

    var tail = h('div', 'lesson-nav');
    if (lesson.lab) {
      tail.appendChild(D.button('Начать ' + lesson.lab.toUpperCase(), null, 'primary', function () {
        NET.progress.markLessonRead(lesson.id);
        NET.ui.labs.start(lesson.lab);
        NET.ui.app.switchCenterTab('terminal');
      }));
    }
    var next = nextLesson(lesson.id);
    if (next) {
      tail.appendChild(D.button('Следующий урок: ' + next.title, null, '', function () {
        NET.progress.markLessonRead(lesson.id);
        open(next.id);
      }));
    }
    box.appendChild(tail);
    NET.bus.emit('lesson:opened', { id: lesson.id });
    return lesson;
  }

  function nextLesson(id) {
    var ids = NET.lessons.ids();
    var i = ids.indexOf(id);
    return (i >= 0 && i + 1 < ids.length) ? NET.lessons.get(ids[i + 1]) : null;
  }

  /* Показать урок вместе с переключением вкладки — то, что нужно кнопкам. */
  function show(id) {
    var lesson = id ? NET.lessons.get(id) : null;
    if (lesson) open(lesson.id); else renderIndex();
    NET.ui.app.switchCenterTab('lesson');
    return lesson;
  }

  function render() {
    /* Открытый тест не перерисовываем: иначе переключение вкладок сбросит ответы. */
    if (NET.ui.quiz && NET.ui.quiz.state()) return;
    if (currentId) open(currentId); else renderIndex();
  }

  NET.ui.lesson = {
    render: render,
    renderIndex: renderIndex,
    open: open,
    show: show,
    current: function () { return currentId; },
    root: root
  };
})(window.NET);
