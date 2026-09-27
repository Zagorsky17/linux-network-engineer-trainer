/*
 * progress.js — профиль специалиста: результаты лабораторий, статистика по
 * навыкам, слабые темы, история. Хранится через NET.storage (IndexedDB →
 * localStorage → память) и экспортируется в файл.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var profile = null;      // раздел userProgress
  var historyLog = null;   // раздел learningHistory
  var saveTimer = null;
  var pending = [];        // ожидающие результата сохранения

  function blank() {
    var data = NET.schema.blank('userProgress');
    data.name = 'Инженер';
    return data;
  }

  /*
   * Загрузка проходит через schema.validate: повреждённые, частичные и данные
   * старой версии приводятся к рабочему виду, а не роняют приложение.
   */
  function load() {
    return Promise.all([
      NET.storage.load('userProgress'),
      NET.storage.load('learningHistory')
    ]).then(function (res) {
      profile = res[0];
      if (!profile.name) profile.name = 'Инженер';
      historyLog = res[1];
      profile.history = historyLog.entries;    // UI работает с одним объектом
      touchStreak();
      NET.bus.emit('progress:loaded', profile);
      return profile;
    }).catch(function (e) {
      NET.errors.report(e, 'progress.load', { level: 'warn' });
      profile = blank();
      historyLog = NET.schema.blank('learningHistory');
      profile.history = historyLog.entries;
      return profile;
    });
  }

  /* Дебаунс с честными обещаниями: результат получают все, кто просил сохранить. */
  function save() {
    if (!profile) return Promise.resolve(false);
    return new Promise(function (resolve) {
      pending.push(resolve);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveTimer = null;
        historyLog.entries = profile.history;
        Promise.all([
          NET.storage.save('userProgress', profile),
          NET.storage.save('learningHistory', historyLog)
        ]).then(function (r) {
          var ok = r[0] && r[1];
          NET.bus.emit('progress:saved', { ok: ok });
          var waiters = pending;
          pending = [];
          waiters.forEach(function (fn) { fn(ok); });
        }, function (e) {
          NET.errors.report(e, 'progress.save', { silent: true, level: 'warn' });
          var waiters = pending;
          pending = [];
          waiters.forEach(function (fn) { fn(false); });
        });
      }, 250);
    });
  }

  function get() {
    if (!profile) {
      profile = blank();
      historyLog = NET.schema.blank('learningHistory');
      profile.history = historyLog.entries;
    }
    return profile;
  }

  function touchStreak() {
    var today = U.isoDate();
    var p = get();
    if (p.streak.last === today) return;
    var yesterday = U.isoDate(Date.now() - U.day);
    p.streak.days = (p.streak.last === yesterday) ? p.streak.days + 1 : 1;
    p.streak.last = today;
    save();
  }

  /* ---------- запись результатов ---------- */

  function recordLab(report) {
    var p = get();
    touchStreak();
    var rec = p.labs[report.labId] || (p.labs[report.labId] = {
      solved: false, best: 0, attempts: 0, variants: [], history: []
    });
    rec.attempts++;
    rec.solved = true;
    rec.best = Math.max(rec.best, report.score);
    if (rec.variants.indexOf(report.variantId) < 0) rec.variants.push(report.variantId);
    rec.history.push({
      at: Date.now(), score: report.score, variant: report.variantId,
      duration: report.duration, hints: report.hints, mode: report.mode
    });
    if (rec.history.length > 30) rec.history.splice(0, rec.history.length - 30);

    p.totals.labsSolved++;
    p.totals.seconds += report.duration;
    p.totals.hints += report.hints;
    p.totals.commands += report.commands.length;

    var quality = Math.max(0, Math.min(1, report.score / 100));
    (report.skills || []).forEach(function (sid) {
      var st = p.skills[sid] || (p.skills[sid] = NET.skills.emptyStats());
      st.attempts++;
      st.solved++;
      st.hints += report.hints;
      st.ewma = st.ewma ? st.ewma * 0.65 + quality * 0.35 : quality;
      st.maxDifficulty = Math.max(st.maxDifficulty, report.difficulty || 1);
      st.difficultySum += report.difficulty || 1;
      st.lastAt = Date.now();
      st.history.push({ at: Date.now(), score: report.score, lab: report.labId });
      if (st.history.length > 40) st.history.splice(0, st.history.length - 40);
      /* пропущенные шаги диагностики — слабые темы */
      (report.steps && report.steps.missed || []).forEach(function (m) {
        st.weak[m.id] = (st.weak[m.id] || 0) + 1;
      });
    });

    p.history.push({
      at: Date.now(), kind: 'lab', id: report.labId, title: report.title,
      score: report.score, grade: report.grade, mode: report.mode
    });
    if (p.history.length > 200) p.history.splice(0, p.history.length - 200);
    historyLog.entries = p.history;

    save();
    NET.bus.emit('progress:updated', { reason: 'lab', report: report });
    return rec;
  }

  function recordTask(task, ok, meta) {
    var p = get();
    touchStreak();
    var rec = p.tasks[task.id] || (p.tasks[task.id] = { solved: 0, failed: 0, lastAt: 0 });
    if (ok) rec.solved++; else rec.failed++;
    rec.lastAt = Date.now();

    var st = p.skills[task.skill] || (p.skills[task.skill] = NET.skills.emptyStats());
    st.attempts++;
    if (ok) st.solved++; else st.failed++;
    var q = ok ? 1 : 0;
    st.ewma = st.ewma ? st.ewma * 0.75 + q * 0.25 : q;
    st.maxDifficulty = Math.max(st.maxDifficulty, ok ? (task.difficulty || 1) : st.maxDifficulty);
    st.lastAt = Date.now();
    if (!ok) st.weak[task.id] = (st.weak[task.id] || 0) + 1;
    else if (st.weak[task.id]) delete st.weak[task.id];

    if (ok) p.totals.tasksSolved++;
    p.history.push({
      at: Date.now(), kind: 'task', id: task.id, title: task.prompt.slice(0, 60),
      score: ok ? 100 : 0, mode: (meta && meta.mode) || 'quick'
    });
    save();
    NET.bus.emit('progress:updated', { reason: 'task', task: task, ok: ok });
    return rec;
  }

  /* ---------- выборки для UI ---------- */

  function skillStats(id) { return get().skills[id] || NET.skills.emptyStats(); }

  function skillsView() {
    return NET.skills.list.map(function (s) {
      var st = skillStats(s.id);
      var pct = NET.skills.mastery(st);
      return {
        id: s.id, title: s.title, desc: s.desc, percent: pct,
        level: NET.skills.levelOf(pct), stats: st,
        weak: Object.keys(st.weak || {}).sort(function (a, b) { return st.weak[b] - st.weak[a]; })
      };
    });
  }

  function overall() {
    return NET.skills.overall(get().skills);
  }

  function weakSkills(limit) {
    var view = skillsView().filter(function (s) { return s.stats.attempts > 0; });
    view.sort(function (a, b) { return a.percent - b.percent; });
    return view.slice(0, limit || 3);
  }

  function isLabSolved(id) {
    var r = get().labs[id];
    return !!(r && r.solved);
  }

  function solvedVariants(labId) {
    var r = get().labs[labId];
    return r ? r.variants.slice() : [];
  }

  function reset() {
    profile = blank();
    historyLog = NET.schema.blank('learningHistory');
    profile.history = historyLog.entries;
    return Promise.all([
      NET.storage.save('userProgress', profile),
      NET.storage.save('learningHistory', historyLog)
    ]).then(function () {
      NET.bus.emit('progress:updated', { reason: 'reset' });
      return true;
    });
  }

  NET.progress = {
    load: load,
    save: save,
    get: get,
    recordLab: recordLab,
    recordTask: recordTask,
    skillStats: skillStats,
    skillsView: skillsView,
    overall: overall,
    weakSkills: weakSkills,
    isLabSolved: isLabSolved,
    solvedVariants: solvedVariants,
    reset: reset
  };
})(window.NET);
