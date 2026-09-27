/*
 * storage.js — слой хранения: каскад IndexedDB -> localStorage -> память
 * плюс разделение данных по разделам и валидация при каждом чтении.
 *
 * Приложение запускается по file://, где origin непрозрачный: часть браузеров
 * бросает SecurityError на indexedDB.open, часть — на localStorage. Поэтому
 * каждая операция обёрнута и API никогда не бросает исключение наружу:
 * при полном отказе хранилища тренажёр работает, но прогресс живёт
 * до перезагрузки (UI показывает предупреждение).
 *
 * Разделы (schema.js описывает структуру каждого):
 *   settings         режим обучения, имя, последний хост
 *   userProgress     лаборатории, навыки, счётчики, стрик
 *   learningHistory  журнал обучения
 *   srsCards         очередь интервального повторения
 *   terminalState    история команд терминала
 * Состояние виртуальных машин намеренно не сохраняется: лаборатория
 * восстанавливается за миллисекунды (reset/rebuild), а хранить снимок мира
 * в браузере дорого и легко рассинхронизировать со кодом сценариев.
 */
(function (NET) {
  'use strict';

  var DB_NAME = 'lnet-trainer';
  var STORE = 'kv';
  var LS_PREFIX = 'lnet:';
  var SCHEMA_KEY = '__schemaVersion';
  var SCHEMA_VERSION = 2;
  var LEGACY = { profile: 'userProgress', srs: 'srsCards', mode: 'settings.mode', 'shell:history': 'terminalState.history' };

  var mem = {};
  var mode = 'memory';
  var db = null;
  var ready = null;
  var quotaWarned = false;
  var lastRepairs = [];

  /* ---------- низкий уровень ---------- */

  function openIDB() {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        if (!window.indexedDB) return reject(new Error('no indexedDB'));
        req = window.indexedDB.open(DB_NAME, 1);
      } catch (e) { return reject(e); }

      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error('indexedDB timeout')); }
      }, 2500);

      req.onupgradeneeded = function () {
        try {
          var d = req.result;
          if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
        } catch (e) { NET.errors.report(e, 'storage.upgrade', { silent: true }); }
      };
      req.onsuccess = function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        var handle = req.result;
        /* другая вкладка обновляет схему — освобождаем соединение */
        handle.onversionchange = function () {
          NET.errors.report('IndexedDB схема изменена в другой вкладке', 'storage.versionchange', { level: 'warn', silent: true });
          try { handle.close(); } catch (e) {}
          db = null;
          mode = lsAvailable() ? 'local' : 'memory';
          NET.storage.mode = mode;
        };
        handle.onclose = function () { db = null; };
        resolve(handle);
      };
      req.onerror = req.onblocked = function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        reject(req.error || new Error('indexedDB blocked'));
      };
    });
  }

  function lsAvailable() {
    try {
      window.localStorage.setItem(LS_PREFIX + '__probe', '1');
      window.localStorage.removeItem(LS_PREFIX + '__probe');
      return true;
    } catch (e) { return false; }
  }

  function idbOp(fn) {
    return new Promise(function (resolve, reject) {
      if (!db) return reject(new Error('no db'));
      var tx, store, req;
      try {
        tx = db.transaction(STORE, 'readwrite');
        store = tx.objectStore(STORE);
        req = fn(store);
      } catch (e) { return reject(e); }
      tx.onabort = function () { reject(tx.error || new Error('transaction aborted')); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function isQuotaError(e) {
    if (!e) return false;
    var name = e.name || '';
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      /quota/i.test(e.message || '');
  }

  function onWriteFailure(e, key) {
    if (isQuotaError(e)) {
      if (!quotaWarned) {
        quotaWarned = true;
        NET.errors.report('Хранилище браузера переполнено: прогресс больше не сохраняется. ' +
          'Выгрузите профиль («Экспорт») и очистите данные сайта.', 'storage.quota', { level: 'warn' });
        NET.bus.emit('storage:full', { key: key });
      }
      return;
    }
    NET.errors.report(e, 'storage.write:' + key, { silent: true, level: 'warn' });
  }

  function _get(key, def) {
    return Promise.resolve().then(function () {
      if (mode === 'idb') {
        return idbOp(function (s) { return s.get(key); }).then(function (v) {
          return v === undefined ? def : v;
        }).catch(function (e) {
          NET.errors.report(e, 'storage.read:' + key, { silent: true, level: 'warn' });
          return def;
        });
      }
      if (mode === 'local') {
        try {
          var raw = window.localStorage.getItem(LS_PREFIX + key);
          if (raw === null) return def;
          return JSON.parse(raw);
        } catch (e) {
          NET.errors.report(e, 'storage.parse:' + key, { silent: true, level: 'warn' });
          return def;
        }
      }
      return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : def;
    });
  }

  function _set(key, value) {
    return Promise.resolve().then(function () {
      if (mode === 'memory') { mem[key] = value; return true; }
      if (mode === 'idb') {
        return idbOp(function (s) { return s.put(value, key); })
          .then(function () { return true; })
          .catch(function (e) { onWriteFailure(e, key); return false; });
      }
      try {
        window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) { onWriteFailure(e, key); return false; }
    });
  }

  function _del(key) {
    return Promise.resolve().then(function () {
      delete mem[key];
      if (mode === 'idb') {
        return idbOp(function (s) { return s.delete(key); })
          .then(function () { return true; })
          .catch(function () { return false; });
      }
      if (mode === 'local') {
        try { window.localStorage.removeItem(LS_PREFIX + key); } catch (e) {}
      }
      return true;
    });
  }

  function _keys() {
    return Promise.resolve().then(function () {
      if (mode === 'idb') {
        return idbOp(function (s) { return s.getAllKeys(); }).catch(function () { return []; });
      }
      if (mode === 'local') {
        var out = [];
        try {
          for (var i = 0; i < window.localStorage.length; i++) {
            var k = window.localStorage.key(i);
            if (k && k.indexOf(LS_PREFIX) === 0) out.push(k.slice(LS_PREFIX.length));
          }
        } catch (e) { NET.errors.report(e, 'storage.keys', { silent: true, level: 'warn' }); }
        return out;
      }
      return Object.keys(mem);
    });
  }

  /* Публичные операции ждут инициализацию; внутренние (_get/_set/...) — нет. */
  function rawGet(key, def) { return init().then(function () { return _get(key, def); }); }
  function rawSet(key, value) { return init().then(function () { return _set(key, value); }); }
  function rawDel(key) { return init().then(function () { return _del(key); }); }
  function rawKeys() { return init().then(function () { return _keys(); }); }

  /* ---------- инициализация и миграция ---------- */

  function init() {
    if (ready) return ready;
    ready = openIDB().then(function (d) {
      db = d; mode = 'idb';
    }).catch(function () {
      mode = lsAvailable() ? 'local' : 'memory';
    }).then(function () {
      NET.storage.mode = mode;
      return migrate();
    }).then(function () {
      NET.bus.emit('storage:ready', { mode: mode });
      return mode;
    });
    return ready;
  }

  /* Переезд со схемы v1 (единый «profile») на разделы v2. */
  function migrate() {
    return _get(SCHEMA_KEY, null).then(function (ver) {
      if (ver === SCHEMA_VERSION) return null;
      return _get('profile', null).then(function (oldProfile) {
        if (!oldProfile) return null;
        var progress = NET.schema.validate('userProgress', oldProfile);
        var history = NET.schema.validate('learningHistory', {
          version: SCHEMA_VERSION,
          entries: Array.isArray(oldProfile.history) ? oldProfile.history : []
        });
        return _set('userProgress', progress.data)
          .then(function () { return _set('learningHistory', history.data); })
          .then(function () { return _get('srs', null); })
          .then(function (oldSrs) {
            if (!oldSrs) return null;
            var cards = NET.schema.validate('srsCards', {
              version: SCHEMA_VERSION, cards: oldSrs.cards
            });
            return _set('srsCards', cards.data);
          })
          .then(function () { return _get('mode', null); })
          .then(function (oldMode) {
            var settings = NET.schema.validate('settings', {
              version: SCHEMA_VERSION, mode: typeof oldMode === 'string' ? oldMode : 'learn'
            });
            return _set('settings', settings.data);
          })
          .then(function () { return _get('shell:history', null); })
          .then(function (oldHist) {
            var term = NET.schema.validate('terminalState', {
              version: SCHEMA_VERSION, history: Array.isArray(oldHist) ? oldHist : []
            });
            return _set('terminalState', term.data);
          })
          .then(function () {
            return Object.keys(LEGACY).reduce(function (chain, key) {
              return chain.then(function () { return _del(key); });
            }, Promise.resolve());
          })
          .then(function () {
            NET.bus.emit('storage:migrated', { from: 1, to: SCHEMA_VERSION });
            return true;
          });
      }).then(function (migrated) {
        return _set(SCHEMA_KEY, SCHEMA_VERSION).then(function () { return migrated; });
      });
    }).catch(function (e) {
      NET.errors.report(e, 'storage.migrate', { level: 'warn', silent: true });
      return null;
    });
  }

  /* ---------- уровень разделов (валидируемый) ---------- */

  function load(kind) {
    return rawGet(kind, null).then(function (raw) {
      var res = NET.schema.validate(kind, raw);
      if (res.repaired.length) {
        lastRepairs = res.repaired.slice(0, 20);
        NET.errors.report('раздел «' + kind + '»: ' + res.repaired.slice(0, 5).join('; '),
          'storage.repair', { level: 'warn', silent: true });
        NET.bus.emit('storage:repaired', { kind: kind, repaired: res.repaired });
      }
      return res.data;
    });
  }

  function save(kind, data) {
    var res = NET.schema.validate(kind, data);
    return rawSet(kind, res.data).then(function (ok) {
      return ok;
    });
  }

  /* ---------- экспорт / импорт ---------- */

  function exportAll() {
    var kinds = NET.schema.kinds();
    var out = {};
    return kinds.reduce(function (p, kind) {
      return p.then(function () {
        return load(kind).then(function (data) { out[kind] = data; });
      });
    }, Promise.resolve()).then(function () {
      return {
        app: 'lnet-trainer',
        version: NET.version,
        schema: SCHEMA_VERSION,
        exported: new Date().toISOString(),
        data: out
      };
    });
  }

  /*
   * importAll(dump) — импорт файла профиля. Данные недоверенные:
   * принимаем только известные разделы и только после валидации.
   */
  function importAll(dump) {
    if (!dump || typeof dump !== 'object') {
      return Promise.reject(new Error('файл не похож на профиль тренажёра'));
    }
    var data = dump.data && typeof dump.data === 'object' ? dump.data : dump;
    var known = NET.schema.kinds().filter(function (k) {
      return Object.prototype.hasOwnProperty.call(data, k);
    });
    /* поддержка файла старого формата (единый profile) */
    if (!known.length && data.profile) {
      return importAll({ data: { userProgress: data.profile, learningHistory: { version: 2, entries: data.profile.history } } });
    }
    if (!known.length) return Promise.reject(new Error('в файле нет известных разделов'));

    var repaired = [];
    return known.reduce(function (p, kind) {
      return p.then(function () {
        var res = NET.schema.validate(kind, data[kind]);
        repaired = repaired.concat(res.repaired.map(function (r) { return kind + '.' + r; }));
        return rawSet(kind, res.data);
      });
    }, Promise.resolve()).then(function () {
      return rawSet(SCHEMA_KEY, SCHEMA_VERSION);
    }).then(function () {
      if (repaired.length) {
        NET.errors.report('импорт: исправлено ' + repaired.length + ' полей', 'storage.import',
          { level: 'warn', silent: true });
      }
      return { kinds: known, repaired: repaired };
    });
  }

  function reset() {
    return rawKeys().then(function (keys) {
      return keys.reduce(function (p, k) { return p.then(function () { return rawDel(k); }); }, Promise.resolve());
    }).then(function () { return rawSet(SCHEMA_KEY, SCHEMA_VERSION); });
  }

  var S = {
    mode: mode,
    init: init,
    /* низкий уровень — для служебных ключей и тестов */
    get: rawGet,
    set: rawSet,
    del: rawDel,
    keys: rawKeys,
    /* разделы со схемой */
    load: load,
    save: save,
    exportAll: exportAll,
    importAll: importAll,
    reset: reset,
    schemaVersion: SCHEMA_VERSION,
    repairs: function () { return lastRepairs.slice(); },

    describe: function () {
      if (mode === 'idb') return 'IndexedDB';
      if (mode === 'local') return 'localStorage (IndexedDB недоступен)';
      return 'только память — прогресс не сохранится после перезагрузки';
    },
    persistent: function () { return mode !== 'memory'; }
  };

  NET.storage = S;
})(window.NET);
