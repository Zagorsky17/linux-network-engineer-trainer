/*
 * world.js — контейнер мира: машины, L2-сегменты, общий буфер захвата.
 * Снапшот мира позволяет мгновенно перезапустить лабораторию (reset)
 * и сохранить незавершённую работу между сессиями.
 */
(function (NET) {
  'use strict';

  var U = NET.util;

  function World(topoId) {
    this.topoId = topoId || 'campus';
    this.capture = new NET.Capture(4000);
    this.machines = {};
    this.order = [];
    this.segments = {};
    this.diagram = null;
    this.current = null;
    this.build();
  }

  World.prototype.build = function () {
    var topo = NET.topology.get(this.topoId);
    if (!topo) throw new Error('unknown topology: ' + this.topoId);
    this.segments = U.clone(topo.segments || {});
    this.diagram = U.clone(topo.diagram || null);
    this.machines = {};
    this.order = [];
    var self = this;
    NET.world = this;   // машины при сборке обращаются к миру (DHCP, netplan)
    topo.machines.forEach(function (spec) {
      var m = new NET.Machine(spec);
      m.spec = spec;
      self.machines[m.name] = m;
      self.order.push(m.name);
      if (spec.primary) self.current = m.name;
    });
    if (!this.current) this.current = this.order[0];
    this.title = topo.title;
  };

  World.prototype.each = function (fn) {
    for (var i = 0; i < this.order.length; i++) {
      var r = fn(this.machines[this.order[i]], this.order[i]);
      if (r === false) return;
    }
  };

  World.prototype.get = function (name) { return this.machines[name] || null; };

  World.prototype.machine = function () { return this.machines[this.current]; };

  World.prototype.shells = function () {
    var out = [];
    this.each(function (m) { if (m.shell) out.push(m); });
    return out;
  };

  World.prototype.setCurrent = function (name) {
    if (!this.machines[name]) return false;
    this.current = name;
    NET.bus.emit('world:host-changed', { host: name });
    return true;
  };

  /* Ищем машину по IP — нужно для ssh/curl и проверок лабораторий. */
  World.prototype.byIP = function (ip) {
    var found = null;
    this.each(function (m) {
      if (found) return;
      if (m.net.ownsIP(ip)) found = m;
    });
    return found;
  };

  World.prototype.snapshot = function () {
    var snap = { topoId: this.topoId, current: this.current, machines: {} };
    var self = this;
    this.each(function (m, name) { snap.machines[name] = m.snapshot(); });
    return snap;
  };

  World.prototype.restore = function (snap) {
    var self = this;
    this.current = snap.current || this.current;
    Object.keys(snap.machines || {}).forEach(function (name) {
      var m = self.machines[name];
      if (m) m.restore(snap.machines[name]);
    });
    this.capture.clear();
    NET.bus.emit('world:restored', {});
  };

  /* Полная пересборка мира с нуля (жёсткий reset лаборатории). */
  World.prototype.rebuild = function () {
    this.capture.clear();
    this.build();
    NET.bus.emit('world:rebuilt', {});
  };

  NET.World = World;
  NET.world = null;
  NET.createWorld = function (topoId) {
    NET.world = new World(topoId);
    return NET.world;
  };
})(window.NET);
