/*
 * process.js — таблица процессов.
 * Процессы привязаны к systemd-юнитам: убитый nginx переводит unit в failed и
 * закрывает его сокеты, что немедленно видно в ss и в поведении curl.
 */
(function (NET) {
  'use strict';

  var U = NET.util;

  function ProcTable(machine) {
    this.machine = machine;
    this.list = [];
    this.nextPid = 800;
    this.bootTime = Date.now() - 3 * 3600 * 1000;
  }

  ProcTable.prototype.spawn = function (spec) {
    if (this.list.length >= U.LIMITS.processes) {
      /* как EAGAIN у fork(): дальше система новых процессов не создаёт */
      this.machine.log('kernel', 'fork: retry: Resource temporarily unavailable', 'err');
      return this.list[this.list.length - 1];
    }
    var p = {
      pid: spec.pid === undefined ? this.nextPid++ : spec.pid,
      ppid: spec.ppid === undefined ? 1 : spec.ppid,
      user: spec.user || 'root',
      cmd: spec.cmd,
      state: spec.state || 'S',
      cpu: spec.cpu === undefined ? +(Math.random() * 0.6).toFixed(1) : spec.cpu,
      mem: spec.mem === undefined ? +(Math.random() * 1.2 + 0.1).toFixed(1) : spec.mem,
      rss: spec.rss || U.randInt(2000, 40000),
      vsz: spec.vsz || U.randInt(20000, 400000),
      tty: spec.tty || '?',
      start: spec.start || this.bootTime,
      unit: spec.unit || null,
      protected: !!spec.protected
    };
    if (p.pid >= this.nextPid) this.nextPid = p.pid + 1;
    this.list.push(p);
    return p;
  };

  ProcTable.prototype.byPid = function (pid) {
    for (var i = 0; i < this.list.length; i++) if (this.list[i].pid === pid) return this.list[i];
    return null;
  };

  ProcTable.prototype.find = function (pattern) {
    var re;
    try { re = new RegExp(pattern); } catch (e) { return []; }
    return this.list.filter(function (p) { return re.test(p.cmd); });
  };

  ProcTable.prototype.byName = function (name) {
    return this.list.filter(function (p) {
      var base = p.cmd.split(' ')[0].split('/').pop();
      return base === name;
    });
  };

  /*
   * Завершает процесс. Возвращает {ok, err}.
   * SIGTERM/SIGKILL по процессу юнита → юнит падает (для SIGKILL) или
   * останавливается штатно (SIGTERM).
   */
  ProcTable.prototype.kill = function (pid, signal, ctx) {
    var p = this.byPid(pid);
    if (!p) return { ok: false, err: 'No such process' };
    if (ctx && ctx.uid !== 0 && p.user !== ctx.user) {
      return { ok: false, err: 'Operation not permitted' };
    }
    signal = signal || 'TERM';
    if (p.pid === 1) return { ok: false, err: 'Operation not permitted' };
    if (signal === 'HUP' || signal === '1') {
      if (p.unit && this.machine.services) this.machine.services.reload(p.unit);
      return { ok: true };
    }
    if (signal === 'STOP' || signal === '19') { p.state = 'T'; return { ok: true }; }
    if (signal === 'CONT' || signal === '18') { p.state = 'S'; return { ok: true }; }

    var i = this.list.indexOf(p);
    this.list.splice(i, 1);
    /* сокеты умирают вместе с процессом: ss перестаёт их показывать */
    var net = this.machine.net;
    if (net && net.sockets) net.sockets = net.sockets.filter(function (s) { return s.pid !== p.pid; });
    if (p.unit && this.machine.services) {
      var crashed = (signal === 'KILL' || signal === '9');
      this.machine.services.processDied(p.unit, crashed);
    }
    return { ok: true };
  };

  ProcTable.prototype.uptimeString = function () {
    var ms = Date.now() - this.bootTime;
    var mins = Math.floor(ms / 60000);
    var h = Math.floor(mins / 60), m = mins % 60;
    var days = Math.floor(h / 24);
    var s = '';
    if (days) s += days + ' day' + (days > 1 ? 's' : '') + ', ';
    s += (h % 24) + ':' + U.pad2(m);
    return s;
  };

  ProcTable.prototype.snapshot = function () {
    return { list: U.clone(this.list), nextPid: this.nextPid, bootTime: this.bootTime };
  };

  ProcTable.prototype.restore = function (s) {
    this.list = U.clone(s.list);
    this.nextPid = s.nextPid;
    this.bootTime = s.bootTime;
  };

  NET.ProcTable = ProcTable;
})(window.NET);
