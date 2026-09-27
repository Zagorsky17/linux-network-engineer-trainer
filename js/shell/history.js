/*
 * history.js — история команд с навигацией стрелками, поиском Ctrl+R
 * и сохранением между запусками (через storage).
 */
(function (NET) {
  'use strict';

  var KIND = 'terminalState';
  var MAX = 500;

  function History(session) {
    this.items = [];
    this.pos = -1;
    this.draft = '';
    this.loaded = false;
    var self = this;
    if (NET.storage) {
      NET.storage.load(KIND).then(function (data) {
        self.items = (data.history || []).slice(-MAX);
        self.loaded = true;
        self.pos = self.items.length;
      }, function (e) {
        NET.errors.report(e, 'history.load', { level: 'warn', silent: true });
        self.loaded = true;
      });
    }
  }

  History.prototype.add = function (line) {
    if (!line || !line.trim()) return;
    if (this.items[this.items.length - 1] === line) { this.pos = this.items.length; return; }
    this.items.push(line);
    if (this.items.length > MAX) this.items.splice(0, this.items.length - MAX);
    this.pos = this.items.length;
    this.persist();
  };

  History.prototype.persist = function () {
    if (!NET.storage) return;
    /* дебаунс: история пишется после каждой команды, а транзакции не бесплатны */
    var self = this;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(function () {
      self._timer = null;
      NET.storage.save(KIND, { version: NET.storage.schemaVersion, history: self.items });
    }, 400);
  };

  History.prototype.clear = function () {
    this.items = [];
    this.pos = 0;
    this.persist();
  };

  History.prototype.prev = function (current) {
    if (this.pos === this.items.length) this.draft = current || '';
    if (this.pos <= 0) { this.pos = 0; return this.items[0] === undefined ? current : this.items[0]; }
    this.pos--;
    return this.items[this.pos];
  };

  History.prototype.next = function () {
    if (this.pos >= this.items.length) return this.draft;
    this.pos++;
    if (this.pos === this.items.length) return this.draft;
    return this.items[this.pos];
  };

  History.prototype.reset = function () { this.pos = this.items.length; this.draft = ''; };

  /* Обратный поиск для Ctrl+R */
  History.prototype.search = function (term, fromEnd) {
    if (!term) return null;
    for (var i = (fromEnd === undefined ? this.items.length - 1 : fromEnd); i >= 0; i--) {
      if (this.items[i].indexOf(term) >= 0) return { line: this.items[i], index: i };
    }
    return null;
  };

  /* Раскрытие !! и !N */
  History.prototype.expandBang = function (line) {
    var self = this;
    if (line.indexOf('!') < 0) return line;
    return line.replace(/!!/g, function () {
      return self.items[self.items.length - 1] || '';
    }).replace(/!(\d+)/g, function (m, n) {
      return self.items[Number(n) - 1] || m;
    });
  };

  NET.History = History;
})(window.NET);
