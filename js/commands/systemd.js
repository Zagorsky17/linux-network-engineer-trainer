/*
 * systemd.js — systemctl, journalctl, service.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;

  function unitComplete(ctx, word, argv, h) {
    var subs = ['status', 'start', 'stop', 'restart', 'reload', 'enable', 'disable',
      'is-active', 'is-enabled', 'list-units', 'list-unit-files', 'daemon-reload', 'cat'];
    if (argv.length <= 1) return subs;
    return h.units(ctx).concat(ctx.machine.services.list().map(function (u) { return u.name; }));
  }

  reg({
    name: 'systemctl', category: 'services', summary: 'управление сервисами',
    usage: 'systemctl {status|start|stop|restart|enable|disable|is-active} UNIT',
    complete: unitComplete,
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['now', 'quiet', 'l', 'no-pager', 'all', 'failed'], value: ['type', 'state'] });
      var sub = p.rest[0];
      var svc = ctx.machine.services;
      var unitName = p.rest[1];

      if (!sub || sub === 'list-units' || sub === 'list-unit-files' || p.flags.failed) {
        var list = svc.list();
        if (p.flags.failed) list = list.filter(function (u) { return u.state === 'failed'; });
        ctx.line(U.padRight('  UNIT', 34) + U.padRight('LOAD', 8) + U.padRight('ACTIVE', 9) +
          U.padRight('SUB', 9) + 'DESCRIPTION');
        list.forEach(function (u) {
          var dot = u.state === 'failed' ? '● ' : (u.state === 'active' ? '  ' : '  ');
          ctx.line(dot + U.padRight(u.name + '.service', 32) + U.padRight('loaded', 8) +
            U.padRight(u.state, 9) + U.padRight(u.sub, 9) + u.description);
        });
        ctx.line('');
        ctx.line(list.length + ' loaded units listed.');
        return 0;
      }

      if (sub === 'daemon-reload' || sub === 'daemon-reexec') {
        if (!ctx.isRoot) return ctx.fail('Failed to reload daemon: Access denied');
        return 0;
      }

      if (!unitName) return ctx.usageError('systemctl: unit name required');
      var u = svc.get(unitName);

      if (sub === 'status') {
        if (!u) {
          ctx.errLine('Unit ' + unitName.replace(/\.service$/, '') + '.service could not be found.');
          return 4;
        }
        var text = svc.statusText(u.name);
        if (ctx.session.onPager && ctx.streaming && text.split('\n').length > 24) {
          ctx.session.onPager(text, 'systemctl status ' + u.name);
        } else ctx.line(text);
        return u.state === 'active' ? 0 : 3;
      }

      if (sub === 'is-active') {
        if (!u) { ctx.line('inactive'); return 3; }
        ctx.line(u.state);
        return u.state === 'active' ? 0 : 3;
      }

      if (sub === 'is-enabled') {
        if (!u) { ctx.errLine('Failed to get unit file state for ' + unitName + ': No such file or directory'); return 1; }
        ctx.line(u.enabled ? 'enabled' : 'disabled');
        return u.enabled ? 0 : 1;
      }

      if (sub === 'cat') {
        if (!u) return ctx.fail('No files found for ' + unitName + '.service.', 1);
        ctx.line('# /lib/systemd/system/' + u.name + '.service');
        ctx.line('[Unit]');
        ctx.line('Description=' + u.description);
        ctx.line('After=network.target');
        ctx.line('');
        ctx.line('[Service]');
        ctx.line('ExecStart=' + u.exec);
        ctx.line('Restart=on-failure');
        ctx.line('');
        ctx.line('[Install]');
        ctx.line('WantedBy=multi-user.target');
        return 0;
      }

      var needRoot = ['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'mask', 'unmask'];
      if (needRoot.indexOf(sub) >= 0 && !ctx.isRoot) {
        ctx.errLine('Failed to ' + sub + ' ' + unitName + '.service: Access denied');
        ctx.errLine('See system logs and \'systemctl status ' + unitName + '.service\' for details.');
        return 1;
      }

      var r;
      if (sub === 'start') r = svc.start(unitName);
      else if (sub === 'stop') r = svc.stop(unitName);
      else if (sub === 'restart' || sub === 'try-restart') r = svc.restart(unitName);
      else if (sub === 'reload') r = svc.reload(unitName);
      else if (sub === 'enable') {
        r = svc.enable(unitName);
        if (r.ok && r.msg) ctx.line(r.msg);
        if (r.ok && p.flags.now) r = svc.start(unitName);
      } else if (sub === 'disable') {
        r = svc.disable(unitName);
        if (r.ok && r.msg) ctx.line(r.msg);
        if (r.ok && p.flags.now) r = svc.stop(unitName);
      } else {
        return ctx.fail('Unknown operation ' + sub + '.');
      }
      if (r && r.err) { ctx.errLine(r.err); return 1; }
      return 0;
    }
  });

  reg({
    name: 'service', category: 'services', summary: 'SysV-совместимый враппер',
    usage: 'service UNIT {start|stop|status|restart}',
    complete: function (ctx, word, argv, h) {
      return argv.length <= 1 ? ctx.machine.services.list().map(function (u) { return u.name; })
        : ['start', 'stop', 'restart', 'status'];
    },
    run: function (ctx) {
      var name = ctx.argv[0], action = ctx.argv[1];
      if (!name || !action) return ctx.usageError('Usage: service < option > | --status-all | [ service_name [ command ] ]');
      ctx.line(' * ' + (action === 'status' ? 'Checking' : 'Restarting') + ' ' + name);
      return NET.shell.invokeAs(ctx, ['systemctl', action, name], ctx.user);
    }
  });

  reg({
    name: 'journalctl', category: 'services', summary: 'журнал systemd',
    usage: 'journalctl [-u UNIT] [-n N] [-p err] [-b] [-f] [--since TIME]',
    complete: function (ctx, word, argv, h) {
      if (argv[argv.length - 1] === '-u') return h.units(ctx);
      return ['-u', '-n', '-p', '-b', '-f', '-e', '--since', '--no-pager', '-x'];
    },
    run: function (ctx) {
      var p = A.parse(ctx.argv, {
        bool: ['b', 'f', 'e', 'x', 'r', 'k', 'no-pager', 'follow'],
        value: ['u', 'n', 'p', 'since', 'until', 'lines', 'priority', 'unit']
      });
      var m = ctx.machine;
      var list = m.journal.slice();
      var unit = p.opts.u || p.opts.unit;
      if (unit) {
        var name = m.services.normalize(unit);
        /* -u ssh показывает и записи процесса sshd: в systemd это один юнит */
        var also = { ssh: ['sshd'], named: ['bind9'], fail2ban: ['fail2ban.server', 'fail2ban.filter', 'fail2ban.actions', 'fail2ban.jail'] }[name] || [];
        list = list.filter(function (l) {
          return l.unit === name || l.unit === unit || also.indexOf(l.unit) >= 0;
        });
      }
      if (p.flags.k) list = list.filter(function (l) { return l.unit === 'kernel'; });
      var prio = p.opts.p || p.opts.priority;
      if (prio) {
        var order = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
        var maxIdx = order.indexOf(prio);
        if (maxIdx < 0) maxIdx = Number(prio);
        list = list.filter(function (l) {
          var i = order.indexOf(l.prio || 'info');
          return i >= 0 && i <= maxIdx;
        });
      }
      if (p.opts.since) {
        var mm = String(p.opts.since).match(/(\d+)\s*(min|hour|sec|day)/);
        if (mm) {
          var mult = { sec: 1000, min: 60000, hour: 3600000, day: 86400000 }[mm[2]];
          var from = Date.now() - Number(mm[1]) * mult;
          list = list.filter(function (l) { return l.ts >= from; });
        }
      }
      if (p.flags.r) list.reverse();
      var n = A.num(p.opts.n || p.opts.lines, p.flags.e ? 1000 : 0);
      if (n) list = list.slice(-n);

      if (!list.length) {
        ctx.line('-- No entries --');
        return 0;
      }
      var lines = [];
      lines.push('-- Journal begins at ' + new Date(Date.now() - 86400000).toString().slice(0, 24) +
        ', ends at ' + new Date().toString().slice(0, 24) + '. --');
      list.forEach(function (l) {
        lines.push(U.syslogTime(l.ts) + ' ' + m.hostname + ' ' + l.unit +
          '[' + (l.pid || 1) + ']: ' + l.msg);
      });
      var text = lines.join('\n');
      if (ctx.session.onPager && ctx.streaming && !p.flags['no-pager'] && lines.length > 30) {
        ctx.session.onPager(text, 'journalctl');
      } else {
        ctx.out(text + '\n');
      }
      if (p.flags.f || p.flags.follow) ctx.line('^C');
      return 0;
    }
  });
})(window.NET);
