/*
 * services.js — systemd-юниты.
 *
 * Юнит владеет своими сокетами: остановленный nginx закрывает 443, и curl
 * получает Connection refused. Падение процесса (kill -9) переводит юнит в
 * failed и пишет в журнал — ровно та связка, которую диагностируют в labs.
 */
(function (NET) {
  'use strict';

  var U = NET.util;

  var ALIASES = { sshd: 'ssh', 'ssh.service': 'ssh', bind9: 'named', 'named.service': 'named' };

  function Services(machine) {
    this.machine = machine;
    this.units = {};
    this.order = [];
  }

  Services.prototype.normalize = function (name) {
    if (!name) return name;
    var n = String(name).replace(/\.service$/, '');
    return ALIASES[n] || n;
  };

  Services.prototype.define = function (spec) {
    var u = {
      name: spec.name,
      description: spec.description || spec.name,
      state: spec.state || 'inactive',       // active | inactive | failed | activating
      sub: spec.sub || (spec.state === 'active' ? 'running' : 'dead'),
      enabled: spec.enabled === undefined ? true : spec.enabled,
      exec: spec.exec || ('/usr/sbin/' + spec.name),
      user: spec.user || 'root',
      ports: spec.ports || [],
      pid: null,
      since: Date.now() - U.randInt(600, 40000) * 1000,
      type: spec.type || 'simple',
      preStart: spec.preStart || null,       // (machine) -> строка с ошибкой или null
      onStart: spec.onStart || null,
      onStop: spec.onStop || null,
      docs: spec.docs || null,
      memory: spec.memory || U.randInt(2, 40) + '.0M',
      tasks: spec.tasks || U.randInt(1, 6),
      logs: spec.logs || [],
      static: !!spec.static
    };
    this.units[u.name] = u;
    this.order.push(u.name);
    if (u.state === 'active') this._bringUp(u, true);
    return u;
  };

  Services.prototype.get = function (name) {
    return this.units[this.normalize(name)] || null;
  };

  Services.prototype.list = function () {
    var self = this;
    return this.order.map(function (n) { return self.units[n]; });
  };

  Services.prototype.isActive = function (name) {
    var u = this.get(name);
    return !!u && u.state === 'active';
  };

  Services.prototype.isEnabled = function (name) {
    var u = this.get(name);
    return !!u && u.enabled;
  };

  Services.prototype._bringUp = function (u, quiet) {
    var m = this.machine;
    u.state = 'active';
    u.sub = u.type === 'oneshot' ? 'exited' : 'running';
    u.since = Date.now();
    var proc = m.procs.spawn({ cmd: u.exec, user: u.user, unit: u.name, ppid: 1 });
    u.pid = proc.pid;
    u.ports.forEach(function (p) {
      m.net.listen({
        proto: p.proto, addr: p.addr || '0.0.0.0', port: p.port,
        pid: proc.pid, process: u.exec.split('/').pop(), unit: u.name
      });
    });
    if (u.onStart) u.onStart(m, u);
    if (!quiet) m.log(u.name, 'Started ' + u.description + '.');
  };

  Services.prototype.start = function (name) {
    var u = this.get(name);
    if (!u) return { err: 'Failed to start ' + name + '.service: Unit ' + name + '.service not found.' };
    if (u.state === 'active') return { ok: true, already: true };
    if (u.preStart) {
      var err = u.preStart(this.machine, u);
      if (err) {
        u.state = 'failed'; u.sub = 'dead'; u.result = 'exit-code';
        this.machine.log(u.name, err, 'err');
        this.machine.log('systemd', u.name + '.service: Failed with result \'exit-code\'.', 'err');
        return { err: 'Job for ' + u.name + '.service failed because the control process exited with error code.\nSee "systemctl status ' + u.name + '.service" and "journalctl -xeu ' + u.name + '.service" for details.' };
      }
    }
    this._bringUp(u, false);
    return { ok: true };
  };

  Services.prototype.stop = function (name) {
    var u = this.get(name);
    if (!u) return { err: 'Failed to stop ' + name + '.service: Unit ' + name + '.service not loaded.' };
    if (u.state !== 'active') { u.state = 'inactive'; u.sub = 'dead'; return { ok: true, already: true }; }
    var m = this.machine;
    m.net.closeUnitSockets(u.name);
    m.procs.list = m.procs.list.filter(function (p) { return p.unit !== u.name; });
    u.state = 'inactive'; u.sub = 'dead'; u.pid = null; u.since = Date.now();
    if (u.onStop) u.onStop(m, u);
    m.log(u.name, 'Stopped ' + u.description + '.');
    return { ok: true };
  };

  Services.prototype.restart = function (name) {
    var s = this.stop(name);
    if (s.err && s.err.indexOf('not loaded') >= 0) return s;
    return this.start(name);
  };

  Services.prototype.reload = function (name) {
    var u = this.get(name);
    if (!u) return { err: 'Unit ' + name + '.service not found.' };
    if (u.state !== 'active') return { err: 'Job for ' + u.name + '.service failed.' };
    if (u.preStart) {
      var err = u.preStart(this.machine, u);
      if (err) {
        this.machine.log(u.name, err, 'err');
        return { err: 'Job for ' + u.name + '.service failed because a configured resource limit was exceeded.' };
      }
    }
    this.machine.log(u.name, 'Reloading ' + u.description + '.');
    if (u.onStart) u.onStart(this.machine, u);
    return { ok: true };
  };

  Services.prototype.enable = function (name) {
    var u = this.get(name);
    if (!u) return { err: 'Failed to enable unit: Unit file ' + name + '.service does not exist.' };
    u.enabled = true;
    return { ok: true, msg: 'Created symlink /etc/systemd/system/multi-user.target.wants/' + u.name + '.service → /lib/systemd/system/' + u.name + '.service.' };
  };

  Services.prototype.disable = function (name) {
    var u = this.get(name);
    if (!u) return { err: 'Failed to disable unit: Unit file ' + name + '.service does not exist.' };
    u.enabled = false;
    return { ok: true, msg: 'Removed "/etc/systemd/system/multi-user.target.wants/' + u.name + '.service".' };
  };

  /* Процесс юнита умер: kill -9 => failed, kill -TERM => inactive. */
  Services.prototype.processDied = function (name, crashed) {
    var u = this.get(name);
    if (!u) return;
    var m = this.machine;
    m.net.closeUnitSockets(u.name);
    u.pid = null; u.since = Date.now();
    if (crashed) {
      u.state = 'failed'; u.sub = 'failed'; u.result = 'signal';
      m.log('systemd', u.name + '.service: Main process exited, code=killed, status=9/KILL', 'err');
      m.log('systemd', u.name + '.service: Failed with result \'signal\'.', 'err');
    } else {
      u.state = 'inactive'; u.sub = 'dead';
      m.log('systemd', u.name + '.service: Deactivated successfully.');
    }
    if (u.onStop) u.onStop(m, u);
  };

  Services.prototype.byPort = function (port, proto) {
    var found = null;
    this.list().forEach(function (u) {
      u.ports.forEach(function (p) {
        if (Number(p.port) === Number(port) && p.proto === (proto || 'tcp')) found = u;
      });
    });
    return found;
  };

  /* Текст для systemctl status. */
  Services.prototype.statusText = function (name) {
    var u = this.get(name);
    if (!u) return null;
    var ago = Math.max(1, Math.floor((Date.now() - u.since) / 1000));
    var agoStr = ago > 3600 ? Math.floor(ago / 3600) + 'h ' + Math.floor((ago % 3600) / 60) + 'min' :
      (ago > 60 ? Math.floor(ago / 60) + 'min ' + (ago % 60) + 's' : ago + 's');
    var dot = u.state === 'active' ? '●' : (u.state === 'failed' ? '×' : '○');
    var lines = [];
    lines.push(dot + ' ' + u.name + '.service - ' + u.description);
    lines.push('     Loaded: loaded (/lib/systemd/system/' + u.name + '.service; ' +
      (u.enabled ? 'enabled' : 'disabled') + '; preset: enabled)');
    if (u.state === 'active') {
      lines.push('     Active: active (' + u.sub + ') since ' +
        new Date(u.since).toString().slice(0, 24) + '; ' + agoStr + ' ago');
    } else if (u.state === 'failed') {
      lines.push('     Active: failed (Result: ' + (u.result || 'exit-code') + ') since ' +
        new Date(u.since).toString().slice(0, 24) + '; ' + agoStr + ' ago');
    } else {
      lines.push('     Active: inactive (dead)');
    }
    if (u.docs) lines.push('       Docs: ' + u.docs);
    if (u.pid) {
      lines.push('   Main PID: ' + u.pid + ' (' + u.exec.split('/').pop() + ')');
      lines.push('      Tasks: ' + u.tasks + ' (limit: 4557)');
      lines.push('     Memory: ' + u.memory);
      lines.push('        CPU: ' + (Math.random() * 3).toFixed(3) + 's');
      lines.push('     CGroup: /system.slice/' + u.name + '.service');
      lines.push('             └─' + u.pid + ' ' + u.exec);
    }
    lines.push('');
    var host = this.machine.hostname;
    var logs = this.machine.journal.filter(function (l) { return l.unit === u.name; }).slice(-6);
    logs.forEach(function (l) {
      lines.push(U.syslogTime(l.ts) + ' ' + host + ' ' + u.name + '[' + (u.pid || 1) + ']: ' + l.msg);
    });
    return lines.join('\n');
  };

  Services.prototype.snapshot = function () {
    var out = {};
    var self = this;
    this.order.forEach(function (n) {
      var u = self.units[n];
      out[n] = { state: u.state, sub: u.sub, enabled: u.enabled, pid: u.pid, since: u.since, result: u.result };
    });
    return out;
  };

  Services.prototype.restore = function (snap) {
    var self = this;
    Object.keys(snap || {}).forEach(function (n) {
      var u = self.units[n];
      if (!u) return;
      u.state = snap[n].state; u.sub = snap[n].sub; u.enabled = snap[n].enabled;
      u.pid = snap[n].pid; u.since = snap[n].since; u.result = snap[n].result;
    });
  };

  NET.Services = Services;
})(window.NET);
