/*
 * modes.js — режимы работы тренажёра.
 * Режим меняет доступ к подсказкам, состав заданий и способ оценки.
 */
(function (NET) {
  'use strict';

  var MODES = [
    {
      id: 'learn', title: 'Обучение', short: 'Обучение',
      desc: 'Подробные подсказки, теория и разбор после каждого шага. Ошибаться безопасно.',
      hints: true, theory: true, timer: false, hintPenalty: 8
    },
    {
      id: 'practice', title: 'Практика', short: 'Практика',
      desc: 'Подсказки по запросу и со штрафом. Разбор — после решения.',
      hints: true, theory: true, timer: false, hintPenalty: 15
    },
    {
      id: 'exam', title: 'Экзамен', short: 'Экзамен',
      desc: 'Без подсказок и пошаговой помощи. Итоговый отчёт в конце.',
      hints: false, theory: false, timer: true, hintPenalty: 0
    },
    {
      id: 'incident', title: 'Troubleshooting', short: 'Инциденты',
      desc: 'Случайный инцидент без описания симптомов: только жалоба «не работает».',
      hints: true, theory: true, timer: true, hintPenalty: 20, random: true, blindBrief: true
    },
    {
      id: 'quick', title: 'Quick Practice', short: 'Быстрая',
      desc: 'Короткая задача на 5–10 минут из очереди повторения слабых тем.',
      hints: true, theory: true, timer: true, tasks: 'state'
    },
    {
      id: 'trainer', title: 'Command Trainer', short: 'Команды',
      desc: 'Тренировка команд и их параметров: нужно ввести правильную команду.',
      hints: true, theory: false, timer: false, tasks: 'command'
    }
  ];

  var currentId = 'learn';

  function get(id) {
    var found = null;
    MODES.forEach(function (m) { if (m.id === (id || currentId)) found = m; });
    return found || MODES[0];
  }

  var settings = null;

  function set(id) {
    if (!get(id)) return false;
    currentId = id;
    if (settings) {
      settings.mode = id;
      NET.storage.save('settings', settings);
    }
    NET.bus.emit('mode:changed', { mode: get(id) });
    return true;
  }

  function load() {
    return NET.storage.load('settings').then(function (s) {
      settings = s;
      if (MODES.some(function (m) { return m.id === s.mode; })) currentId = s.mode;
      return currentId;
    }).catch(function (e) {
      NET.errors.report(e, 'modes.load', { level: 'warn', silent: true });
      return currentId;
    });
  }

  function settingsObject() { return settings || (settings = NET.schema.blank('settings')); }

  NET.modes = {
    list: MODES,
    get: get,
    set: set,
    load: load,
    settings: settingsObject,
    current: function () { return currentId; }
  };
})(window.NET);
