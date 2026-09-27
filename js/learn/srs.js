/*
 * srs.js — интервальное повторение (вариант SM-2).
 *
 * Карточка создаётся не «на команду», а на слабое место: пропущенный шаг
 * диагностики, проваленную проверку, тему, где были подсказки. Очередь due
 * питает режим Quick Practice — повторяются именно ошибки.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var KIND = 'srsCards';
  var INTERVALS = [1, 3, 7, 16, 35, 70];   // дни
  var state = null;

  function blank() { return NET.schema.blank(KIND); }

  function load() {
    return NET.storage.load(KIND).then(function (s) {
      state = s;
      return state;
    }).catch(function (e) {
      NET.errors.report(e, 'srs.load', { level: 'warn', silent: true });
      state = blank();
      return state;
    });
  }

  function get() { return state || (state = blank()); }
  function save() { return NET.storage.save(KIND, get()); }

  function card(id, meta) {
    var s = get();
    if (!s.cards[id]) {
      s.cards[id] = {
        id: id, skill: (meta && meta.skill) || 'troubleshooting',
        title: (meta && meta.title) || id,
        kind: (meta && meta.kind) || 'topic',
        step: 0, due: Date.now(), lapses: 0, reps: 0, lastAt: 0
      };
    } else if (meta) {
      if (meta.title) s.cards[id].title = meta.title;
      if (meta.skill) s.cards[id].skill = meta.skill;
    }
    return s.cards[id];
  }

  /* quality: 0 — провал, 1 — решено с подсказкой, 2 — решено уверенно */
  function review(id, quality, meta) {
    var c = card(id, meta);
    c.reps++;
    c.lastAt = Date.now();
    if (quality <= 0) {
      c.lapses++;
      c.step = 0;
      c.due = Date.now() + U.day;      // вернуть завтра
    } else if (quality === 1) {
      c.step = Math.max(0, c.step);
      c.due = Date.now() + INTERVALS[Math.min(c.step, INTERVALS.length - 1)] * U.day;
    } else {
      c.step = Math.min(c.step + 1, INTERVALS.length - 1);
      c.due = Date.now() + INTERVALS[c.step] * U.day;
    }
    save();
    NET.bus.emit('srs:updated', { card: c });
    return c;
  }

  function due(limit) {
    var s = get();
    var now = Date.now();
    var list = Object.keys(s.cards).map(function (k) { return s.cards[k]; })
      .filter(function (c) { return c.due <= now; });
    list.sort(function (a, b) { return a.due - b.due; });
    return limit ? list.slice(0, limit) : list;
  }

  function dueCount() { return due().length; }

  function all() {
    var s = get();
    return Object.keys(s.cards).map(function (k) { return s.cards[k]; });
  }

  /* Разбор лабораторной: чему назначить повторение. */
  function afterLab(report) {
    var solvedClean = report.hints === 0 && report.coverage >= 0.8;
    (report.skills || []).forEach(function (sid) {
      var skill = NET.skills.get(sid);
      review('skill:' + sid, solvedClean ? 2 : 1, {
        skill: sid, title: skill ? skill.title : sid, kind: 'skill'
      });
    });
    /* пропущенные шаги диагностики — отдельные карточки */
    (report.steps && report.steps.missed || []).forEach(function (m) {
      review('step:' + report.labId + ':' + m.id, 0, {
        skill: (report.skills || ['troubleshooting'])[0],
        title: m.title, kind: 'step'
      });
    });
    if (report.hints > 0) {
      review('lab:' + report.labId, 1, {
        skill: (report.skills || ['troubleshooting'])[0],
        title: report.title, kind: 'lab'
      });
    } else {
      review('lab:' + report.labId, 2, {
        skill: (report.skills || ['troubleshooting'])[0],
        title: report.title, kind: 'lab'
      });
    }
    var theory = report.debrief && report.debrief.theory;
    if (theory && (report.hints > 0 || report.coverage < 0.7)) {
      var t = NET.theory && NET.theory.get(theory);
      review('theory:' + theory, 0, {
        skill: (report.skills || ['troubleshooting'])[0],
        title: t ? t.title : theory, kind: 'theory'
      });
    }
  }

  function afterTask(task, ok) {
    review('task:' + task.id, ok ? 2 : 0, {
      skill: task.skill, title: task.prompt.slice(0, 70), kind: 'task'
    });
  }

  /* Следующее задание для Quick Practice, с опорой на очередь повторений. */
  function nextTask(opts) {
    opts = opts || {};
    var cards = due(12);
    var skills = [];
    cards.forEach(function (c) { if (skills.indexOf(c.skill) < 0) skills.push(c.skill); });
    if (!skills.length && NET.progress) {
      skills = NET.progress.weakSkills(3).map(function (s) { return s.id; });
    }
    var task = null;
    for (var i = 0; i < skills.length && !task; i++) {
      task = NET.taskPool.pick({ skill: skills[i], type: opts.type, exclude: opts.exclude });
    }
    if (!task) task = NET.taskPool.pick({ type: opts.type, exclude: opts.exclude });
    return task;
  }

  function reset() {
    state = blank();
    return save();
  }

  NET.srs = {
    load: load, save: save, review: review, due: due, dueCount: dueCount,
    all: all, afterLab: afterLab, afterTask: afterTask, nextTask: nextTask, reset: reset
  };
})(window.NET);
