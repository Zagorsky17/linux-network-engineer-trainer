/*
 * schema.js — валидация и миграция сохранённых данных.
 *
 * Данные из IndexedDB/localStorage и тем более импортированный файл считаются
 * НЕДОВЕРЕННЫМИ: они могут быть от старой версии, повреждены, обрезаны или
 * подделаны. Любая загрузка проходит через validate(), которая:
 *   • приводит типы и подставляет значения по умолчанию;
 *   • обрезает слишком длинные массивы и строки;
 *   • выбрасывает опасные ключи (__proto__, constructor, prototype);
 *   • сообщает список исправлений, чтобы их можно было залогировать.
 * Приложение обязано работать при любом содержимом хранилища.
 */
(function (NET) {
  'use strict';

  var UNSAFE = { __proto__: true, constructor: true, prototype: true };

  function safeKeys(obj) {
    if (!obj || typeof obj !== 'object') return [];
    return Object.keys(obj).filter(function (k) { return !UNSAFE[k]; });
  }

  /* Создаёт объект без прототипа и переносит только безопасные ключи. */
  function safeObject(src) {
    var out = {};
    safeKeys(src).forEach(function (k) { out[k] = src[k]; });
    return out;
  }

  /* ---------- примитивные спецификации ---------- */

  function fix(ctx, path, why) { ctx.repaired.push(path + ': ' + why); }

  function num(def, min, max) {
    return function (v, ctx, path) {
      if (typeof v === 'number' && isFinite(v)) {
        if (min !== undefined && v < min) { fix(ctx, path, 'меньше минимума'); return min; }
        if (max !== undefined && v > max) { fix(ctx, path, 'больше максимума'); return max; }
        return v;
      }
      if (typeof v === 'string' && v !== '' && isFinite(Number(v))) {
        fix(ctx, path, 'строка вместо числа');
        return num(def, min, max)(Number(v), ctx, path);
      }
      if (v !== undefined) fix(ctx, path, 'не число');
      return def;
    };
  }

  function str(def, maxLen) {
    return function (v, ctx, path) {
      if (typeof v === 'string') {
        if (maxLen && v.length > maxLen) { fix(ctx, path, 'строка обрезана'); return v.slice(0, maxLen); }
        return v;
      }
      if (v !== undefined && v !== null) fix(ctx, path, 'не строка');
      return def;
    };
  }

  function bool(def) {
    return function (v, ctx, path) {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1) return true;
      if (v === 'false' || v === 0) return false;
      if (v !== undefined) fix(ctx, path, 'не булево');
      return def;
    };
  }

  function arr(item, maxLen) {
    return function (v, ctx, path) {
      if (!Array.isArray(v)) {
        if (v !== undefined) fix(ctx, path, 'не массив');
        return [];
      }
      var src = v;
      if (maxLen && src.length > maxLen) {
        fix(ctx, path, 'массив обрезан до ' + maxLen);
        src = src.slice(-maxLen);
      }
      var out = [];
      src.forEach(function (x, i) {
        var val = item(x, ctx, path + '[' + i + ']');
        if (val !== undefined) out.push(val);
      });
      return out;
    };
  }

  /* Словарь: ключ -> значение по одной спецификации. */
  function map(value, maxKeys) {
    return function (v, ctx, path) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        if (v !== undefined) fix(ctx, path, 'не объект');
        return {};
      }
      var keys = safeKeys(v);
      if (keys.length !== Object.keys(v).length) fix(ctx, path, 'удалены небезопасные ключи');
      if (maxKeys && keys.length > maxKeys) {
        fix(ctx, path, 'слишком много ключей, оставлено ' + maxKeys);
        keys = keys.slice(0, maxKeys);
      }
      var out = {};
      keys.forEach(function (k) {
        if (k.length > 120) { fix(ctx, path, 'ключ слишком длинный'); return; }
        out[k] = value(v[k], ctx, path + '.' + k);
      });
      return out;
    };
  }

  function obj(shape) {
    return function (v, ctx, path) {
      var src = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      if (v !== undefined && src !== v) fix(ctx, path, 'не объект');
      var out = {};
      Object.keys(shape).forEach(function (k) {
        out[k] = shape[k](src[k], ctx, (path ? path + '.' : '') + k);
      });
      return out;
    };
  }

  function any(def) {
    return function (v) { return v === undefined ? def : v; };
  }

  /* ---------- описания хранимых сущностей ---------- */

  var skillStat = obj({
    solved: num(0, 0, 1e6),
    attempts: num(0, 0, 1e6),
    failed: num(0, 0, 1e6),
    ewma: num(0, 0, 1),
    hints: num(0, 0, 1e6),
    maxDifficulty: num(0, 0, 5),
    difficultySum: num(0, 0, 1e6),
    weak: map(num(0, 0, 1e4), 100),
    lastAt: num(0, 0, 1e15),
    history: arr(obj({
      at: num(0, 0, 1e15), score: num(0, 0, 100), lab: str('', 40)
    }), 40)
  });

  var labRecord = obj({
    solved: bool(false),
    best: num(0, 0, 100),
    attempts: num(0, 0, 1e5),
    variants: arr(str('', 60), 20),
    history: arr(obj({
      at: num(0, 0, 1e15), score: num(0, 0, 100), variant: str('', 60),
      duration: num(0, 0, 1e7), hints: num(0, 0, 100), mode: str('learn', 20)
    }), 30)
  });

  var KINDS = {
    settings: {
      version: 2,
      spec: obj({
        version: num(2, 1, 99),
        mode: str('learn', 20),
        name: str('Инженер', 60),
        lastHost: str('', 40)
      })
    },
    userProgress: {
      version: 2,
      spec: obj({
        version: num(2, 1, 99),
        created: num(0, 0, 1e15),
        labs: map(labRecord, 200),
        tasks: map(obj({
          solved: num(0, 0, 1e5), failed: num(0, 0, 1e5), lastAt: num(0, 0, 1e15)
        }), 500),
        skills: map(skillStat, 60),
        lessons: map(obj({ readAt: num(0, 0, 1e15), times: num(0, 0, 1e5) }), 100),
        totals: obj({
          labsSolved: num(0, 0, 1e6), tasksSolved: num(0, 0, 1e6),
          commands: num(0, 0, 1e8), seconds: num(0, 0, 1e9), hints: num(0, 0, 1e6)
        }),
        streak: obj({ days: num(0, 0, 1e5), last: str('', 12) })
      })
    },
    learningHistory: {
      version: 2,
      spec: obj({
        version: num(2, 1, 99),
        entries: arr(obj({
          at: num(0, 0, 1e15),
          kind: str('lab', 12),
          id: str('', 60),
          title: str('', 200),
          score: num(0, 0, 100),
          grade: str('', 40),
          mode: str('', 20)
        }), 200)
      })
    },
    srsCards: {
      version: 2,
      spec: obj({
        version: num(2, 1, 99),
        cards: map(obj({
          id: str('', 120), skill: str('troubleshooting', 40), title: str('', 200),
          kind: str('topic', 20), step: num(0, 0, 10), due: num(0, 0, 1e15),
          lapses: num(0, 0, 1e4), reps: num(0, 0, 1e5), lastAt: num(0, 0, 1e15)
        }), 400)
      })
    },
    terminalState: {
      version: 2,
      spec: obj({
        version: num(2, 1, 99),
        history: arr(str('', 2000), 500)
      })
    }
  };

  /* ---------- API ---------- */

  function blank(kind) {
    var k = KINDS[kind];
    if (!k) throw new Error('unknown schema kind: ' + kind);
    var ctx = { repaired: [] };
    var data = k.spec(undefined, ctx, '');
    data.version = k.version;
    if (kind === 'userProgress') {
      data.created = Date.now();
      NET.skills.list.forEach(function (s) {
        if (!data.skills[s.id]) data.skills[s.id] = skillStat(undefined, ctx, 'skills.' + s.id);
      });
    }
    return data;
  }

  /*
   * validate(kind, raw) -> {data, repaired:[], fromVersion}
   * Никогда не бросает: на вход можно подать что угодно.
   */
  function validate(kind, raw) {
    var k = KINDS[kind];
    if (!k) return { data: null, repaired: ['неизвестный раздел ' + kind], fromVersion: null };
    var ctx = { repaired: [] };
    var input = raw;
    if (typeof input === 'string') {
      input = NET.errors.attempt('schema.parse:' + kind, function () { return JSON.parse(input); }, null, { silent: true });
      if (input) ctx.repaired.push('данные пришли строкой, разобраны как JSON');
    }
    var fromVersion = (input && typeof input === 'object' && typeof input.version === 'number') ? input.version : null;
    var data = k.spec(input === null ? undefined : input, ctx, '');
    data.version = k.version;
    if (fromVersion !== null && fromVersion !== k.version) {
      ctx.repaired.push('данные версии ' + fromVersion + ' приведены к версии ' + k.version);
    }
    if (kind === 'userProgress') {
      NET.skills.list.forEach(function (s) {
        if (!data.skills[s.id]) data.skills[s.id] = skillStat(undefined, ctx, 'skills.' + s.id);
      });
      if (!data.created) data.created = Date.now();
    }
    return { data: data, repaired: ctx.repaired, fromVersion: fromVersion };
  }

  NET.schema = {
    KINDS: KINDS,
    kinds: function () { return Object.keys(KINDS); },
    version: function (kind) { return KINDS[kind] ? KINDS[kind].version : null; },
    blank: blank,
    validate: validate,
    safeObject: safeObject,
    safeKeys: safeKeys,
    isUnsafeKey: function (k) { return !!UNSAFE[k]; },
    spec: { num: num, str: str, bool: bool, arr: arr, map: map, obj: obj, any: any }
  };
})(window.NET);
