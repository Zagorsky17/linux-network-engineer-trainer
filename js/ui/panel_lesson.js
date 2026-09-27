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

  /* ---------- список уроков ---------- */

  function renderIndex() {
    var box = root();
    if (!box) return;
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
      meta.appendChild(h('span', null, '~' + l.minutes + ' мин'));
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

  function open(id) {
    var lesson = NET.lessons.get(id);
    var box = root();
    if (!lesson || !box) return null;
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
    meta.appendChild(D.chip('~' + lesson.minutes + ' мин'));
    if (NET.progress.isLessonRead(lesson.id)) meta.appendChild(D.chip('прочитано', 'ok'));
    article.appendChild(meta);

    article.appendChild(h('p', 'lesson-lead', lesson.lead));

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

    if (lesson.practice) {
      var practice = h('div', 'lesson-practice');
      practice.appendChild(h('b', null, 'К практике. '));
      practice.appendChild(D.text(lesson.practice));
      article.appendChild(practice);
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
    if (currentId) open(currentId); else renderIndex();
  }

  NET.ui.lesson = {
    render: render,
    renderIndex: renderIndex,
    open: open,
    show: show,
    current: function () { return currentId; }
  };
})(window.NET);
