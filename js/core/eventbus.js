/* eventbus.js — минимальная шина событий, связывает VM, лаборатории и UI. */
(function (NET) {
  'use strict';

  function Bus() { this._h = {}; }

  Bus.prototype.on = function (name, fn) {
    (this._h[name] || (this._h[name] = [])).push(fn);
    return fn;
  };

  Bus.prototype.off = function (name, fn) {
    var list = this._h[name];
    if (!list) return;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };

  Bus.prototype.once = function (name, fn) {
    var self = this;
    var wrap = function (data) { self.off(name, wrap); fn(data); };
    this.on(name, wrap);
  };

  /*
   * Рассылка идёт по снимку списка: обработчик может подписаться или
   * отписаться во время события, не ломая очередь (раньше list[i] по живому
   * массиву пропускал следующего подписчика после off()).
   * Ошибка в одном обработчике не отменяет остальных.
   */
  Bus.prototype.emit = function (name, data) {
    var list = this._h[name];
    if (!list || !list.length) return;
    var snapshot = list.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try {
        snapshot[i](data);
      } catch (e) {
        if (NET.errors) NET.errors.report(e, 'bus:' + name, { silent: true });
        else if (window.console) console.error('handler error for ' + name, e);
      }
    }
  };

  NET.Bus = Bus;
  NET.bus = new Bus();
})(window.NET);
