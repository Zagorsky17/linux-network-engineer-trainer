/*
 * net_fw.js — ufw, iptables, nft поверх общей модели Netfilter.
 * Правило, добавленное любым из них, реально влияет на прохождение пакета.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;

  var SERVICE_PORTS = {
    ssh: 22, http: 80, https: 443, 'http/tcp': 80, dns: 53, domain: 53,
    smtp: 25, mysql: 3306, postgres: 5432, ntp: 123
  };

  /* ---------- ufw ---------- */

  function parseUfwRule(args) {
    var rule = { action: args[0], direction: 'in', proto: 'any', port: null, from: 'any', to: 'any' };
    var rest = args.slice(1);
    var i = 0;
    while (i < rest.length) {
      var t = rest[i];
      if (t === 'in') { rule.direction = 'in'; i++; continue; }
      if (t === 'out') { rule.direction = 'out'; i++; continue; }
      if (t === 'routed') { rule.direction = 'routed'; i++; continue; }
      if (t === 'on') { rule.iface = rest[i + 1]; i += 2; continue; }
      if (t === 'from') { rule.from = rest[i + 1]; i += 2; continue; }
      if (t === 'to') {
        rule.to = rest[i + 1];
        i += 2;
        continue;
      }
      if (t === 'port') { rule.port = rest[i + 1]; i += 2; continue; }
      if (t === 'proto') { rule.proto = rest[i + 1]; i += 2; continue; }
      if (t === 'comment') { rule.comment = rest.slice(i + 1).join(' ').replace(/['"]/g, ''); break; }
      /* формы «allow 443», «allow 443/tcp», «allow ssh» */
      var m = String(t).match(/^(\d+(?::\d+)?)(?:\/(tcp|udp))?$/);
      if (m) { rule.port = m[1]; if (m[2]) rule.proto = m[2]; i++; continue; }
      if (SERVICE_PORTS[t] !== undefined) {
        rule.port = SERVICE_PORTS[t];
        rule.proto = 'tcp';
        i++;
        continue;
      }
      i++;
    }
    return rule;
  }

  reg({
    name: 'ufw', category: 'firewall', summary: 'простой firewall',
    usage: 'ufw {enable|disable|status [verbose|numbered]|allow ...|deny ...|delete N|default ...|reset}',
    complete: function (ctx, word, argv) {
      if (argv.length <= 1) return ['status', 'enable', 'disable', 'allow', 'deny', 'reject', 'limit',
        'delete', 'default', 'reload', 'reset', 'logging'];
      if (argv[1] === 'status') return ['verbose', 'numbered'];
      if (argv[1] === 'default') return ['deny', 'allow', 'reject'];
      return ['22/tcp', '80/tcp', '443/tcp', 'from', 'to', 'port', 'proto'];
    },
    run: function (ctx) {
      var fw = ctx.machine.fw;
      var argv = ctx.argv.filter(function (a) { return a !== '--force'; });
      var sub = argv[0];
      if (!sub) {
        ctx.line('Usage: ufw COMMAND');
        ctx.line('');
        ctx.line('Commands:');
        ctx.line(' enable                          enables the firewall');
        ctx.line(' disable                         disables the firewall');
        ctx.line(' status                          show firewall status');
        ctx.line(' allow ARGS                      add allow rule');
        ctx.line(' deny ARGS                       add deny rule');
        ctx.line(' delete RULE|NUM                 delete RULE');
        return 0;
      }

      if (sub === 'status') {
        if (!ctx.isRoot) return ctx.fail('ERROR: You need to be root to run this script', 1);
        ctx.out(fw.renderUfwStatus(argv[1] === 'numbered', argv[1] === 'verbose') + '\n');
        return 0;
      }

      if (!ctx.isRoot) return ctx.fail('ERROR: You need to be root to run this script', 1);

      if (sub === 'enable') {
        fw.ufw.enabled = true;
        ctx.machine.services.start('ufw');
        ctx.machine.log('ufw', 'Firewall enabled; default incoming policy: ' + fw.ufw.defaults.incoming);
        ctx.line('Firewall is active and enabled on system startup');
        return 0;
      }
      if (sub === 'disable') {
        fw.ufw.enabled = false;
        ctx.machine.log('ufw', 'Firewall stopped and disabled on system startup');
        ctx.line('Firewall stopped and disabled on system startup');
        return 0;
      }
      if (sub === 'reload') { ctx.line('Firewall reloaded'); return 0; }
      if (sub === 'reset') {
        fw.ufw.enabled = false;
        fw.ufw.rules = [];
        ctx.line('Resetting all rules to installed defaults. This may disrupt existing ssh');
        ctx.line('connections. Proceed with operation (y|n)? y');
        ctx.line('Backing up \'user.rules\' to \'/etc/ufw/user.rules.20260927\'');
        return 0;
      }
      if (sub === 'logging') { ctx.line('Logging ' + (argv[1] || 'on')); return 0; }

      if (sub === 'default') {
        var action = argv[1], dir = argv[2] || 'incoming';
        if (['allow', 'deny', 'reject'].indexOf(action) < 0) {
          return ctx.fail('ERROR: Unsupported default policy', 1);
        }
        fw.ufw.defaults[dir] = action;
        ctx.line('Default ' + dir + ' policy changed to \'' + action + '\'');
        ctx.line('(be sure to update your rules accordingly)');
        return 0;
      }

      if (sub === 'delete') {
        var r;
        if (/^\d+$/.test(argv[1])) r = fw.ufwDelete({ num: Number(argv[1]) });
        else {
          var parsed = parseUfwRule(argv.slice(1));
          r = fw.ufwDelete({ port: parsed.port, proto: parsed.proto });
        }
        if (r.err) { ctx.errLine('ERROR: ' + r.err); return 1; }
        ctx.line('Rule deleted');
        return 0;
      }

      if (['allow', 'deny', 'reject', 'limit'].indexOf(sub) >= 0) {
        var rule = parseUfwRule(argv);
        if (rule.port === null && rule.from === 'any') {
          ctx.errLine('ERROR: Wrong number of arguments');
          return 1;
        }
        var res = fw.ufwAdd(rule);
        ctx.line(res.dup ? 'Skipping adding existing rule' : 'Rule added');
        ctx.machine.log('ufw', 'rule ' + sub + ' ' + (rule.port || 'any') + '/' + rule.proto +
          ' from ' + rule.from);
        return 0;
      }

      ctx.errLine('ERROR: Invalid syntax');
      return 1;
    }
  });

  /* ---------- iptables ---------- */

  function parseIptRule(argv) {
    var rule = { proto: 'all', target: null };
    for (var i = 0; i < argv.length; i++) {
      var a = argv[i];
      if (a === '-p' || a === '--protocol') rule.proto = argv[++i];
      else if (a === '--dport' || a === '--destination-port') rule.dport = argv[++i];
      else if (a === '--sport' || a === '--source-port') rule.sport = argv[++i];
      else if (a === '-s' || a === '--source') rule.src = argv[++i];
      else if (a === '-d' || a === '--destination') rule.dst = argv[++i];
      else if (a === '-i' || a === '--in-interface') rule.iface = argv[++i];
      else if (a === '-o' || a === '--out-interface') rule.outIface = argv[++i];
      else if (a === '--ctstate' || a === '--state') rule.states = argv[++i].split(',');
      else if (a === '-j' || a === '--jump') rule.target = argv[++i];
      else if (a === '-m') i++;   // модуль: conntrack/state — учитываем через --ctstate
      else if (a === '--comment') rule.comment = argv[++i];
    }
    return rule;
  }

  reg({
    name: 'iptables', aliases: ['ip6tables', 'iptables-legacy'], category: 'firewall',
    summary: 'правила netfilter',
    usage: 'iptables [-t filter] {-L|-S|-A|-I|-D|-F|-P} CHAIN [rule] [-j TARGET]',
    complete: function (ctx, word, argv) {
      if (argv.length <= 1) return ['-L', '-S', '-A', '-I', '-D', '-F', '-P', '-n', '-v'];
      return ['INPUT', 'OUTPUT', 'FORWARD', '-p', 'tcp', 'udp', '--dport', '-s', '-j', 'ACCEPT', 'DROP', 'REJECT'];
    },
    run: function (ctx) {
      var fw = ctx.machine.fw;
      var argv = ctx.argv.slice();
      if (!ctx.isRoot) {
        ctx.errLine('iptables v1.8.10 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)');
        return 4;
      }
      var table = 'filter';
      var ti = argv.indexOf('-t');
      if (ti >= 0) { table = argv[ti + 1]; argv.splice(ti, 2); }
      if (table !== 'filter') {
        ctx.line('Chain PREROUTING (policy ACCEPT)');
        ctx.line('target     prot opt source               destination');
        ctx.line('Chain POSTROUTING (policy ACCEPT)');
        ctx.line('target     prot opt source               destination');
        ctx.line('MASQUERADE  all  --  192.168.10.0/24      0.0.0.0/0');
        return 0;
      }

      var i = 0;
      while (i < argv.length) {
        var a = argv[i];
        if (a === '-L' || a === '--list') {
          var chain = argv[i + 1] && argv[i + 1][0] !== '-' ? argv[i + 1].toUpperCase() : null;
          ctx.out(fw.renderIptablesList(chain, argv.indexOf('-n') >= 0, argv.indexOf('-v') >= 0));
          return 0;
        }
        if (a === '-S') {
          ctx.out(fw.renderIptablesSave());
          return 0;
        }
        if (a === '-F' || a === '--flush') {
          fw.flush(argv[i + 1] ? argv[i + 1].toUpperCase() : null);
          return 0;
        }
        if (a === '-P' || a === '--policy') {
          var ch = (argv[i + 1] || '').toUpperCase();
          var pol = (argv[i + 2] || '').toUpperCase();
          if (!fw.policy[ch]) { ctx.errLine('iptables: Bad built-in chain name.'); return 2; }
          if (['ACCEPT', 'DROP'].indexOf(pol) < 0) { ctx.errLine('iptables: Bad policy name.'); return 2; }
          fw.policy[ch] = pol;
          return 0;
        }
        if (a === '-A' || a === '-I' || a === '-D') {
          var chain2 = (argv[i + 1] || '').toUpperCase();
          if (!fw.chains[chain2]) {
            ctx.errLine("iptables: No chain/target/match by that name.");
            return 1;
          }
          var rest = argv.slice(i + 2);
          if (a === '-D' && /^\d+$/.test(rest[0])) {
            var idx = Number(rest[0]) - 1;
            if (!fw.chains[chain2][idx]) { ctx.errLine('iptables: Index of deletion too big.'); return 1; }
            fw.chains[chain2].splice(idx, 1);
            return 0;
          }
          var rule = parseIptRule(rest);
          if (!rule.target) { ctx.errLine('iptables: no target specified (-j)'); return 2; }
          if (a === '-D') {
            var r = fw.delRule(chain2, { proto: rule.proto, dport: rule.dport, target: rule.target });
            if (r.err) { ctx.errLine(r.err); return 1; }
            return 0;
          }
          fw.addRule(chain2, rule, { insert: a === '-I' });
          ctx.machine.log('kernel', 'iptables: ' + chain2 + ' rule added -j ' + rule.target);
          return 0;
        }
        i++;
      }
      ctx.errLine('iptables v1.8.10 (nf_tables): no command specified');
      ctx.errLine('Try `iptables -h\' or \'iptables --help\' for more information.');
      return 2;
    }
  });

  reg({
    name: 'iptables-save', category: 'firewall', summary: 'выгрузить правила',
    usage: 'iptables-save',
    run: function (ctx) {
      if (!ctx.isRoot) return ctx.fail('iptables-save: Permission denied (you must be root)', 4);
      ctx.out(ctx.machine.fw.renderIptablesSave());
      return 0;
    }
  });

  /* ---------- nft ---------- */

  reg({
    name: 'nft', category: 'firewall', summary: 'nftables',
    usage: 'nft list ruleset | nft add rule inet filter input tcp dport N accept',
    complete: function (ctx, word, argv) {
      if (argv.length <= 1) return ['list', 'add', 'flush', 'delete'];
      return ['ruleset', 'rule', 'table', 'inet', 'filter', 'input', 'output', 'forward'];
    },
    run: function (ctx) {
      var fw = ctx.machine.fw;
      var argv = ctx.argv.slice();
      if (!ctx.isRoot) return ctx.fail('Error: Could not process rule: Operation not permitted', 1);
      if (argv[0] === 'list') {
        ctx.out(fw.renderNft() + '\n');
        return 0;
      }
      if (argv[0] === 'flush') { fw.flush(); return 0; }
      if (argv[0] === 'add' && argv[1] === 'rule') {
        var chain = (argv[4] || 'input').toUpperCase();
        var rule = { proto: 'all', target: 'ACCEPT' };
        for (var i = 5; i < argv.length; i++) {
          var t = argv[i];
          if (t === 'tcp' || t === 'udp') rule.proto = t;
          else if (t === 'dport') rule.dport = argv[i + 1];
          else if (t === 'saddr') rule.src = argv[i + 1];
          else if (t === 'daddr') rule.dst = argv[i + 1];
          else if (t === 'accept') rule.target = 'ACCEPT';
          else if (t === 'drop') rule.target = 'DROP';
          else if (t === 'reject') rule.target = 'REJECT';
        }
        if (!fw.chains[chain]) { ctx.errLine('Error: No such file or directory'); return 1; }
        fw.addRule(chain, rule, {});
        return 0;
      }
      ctx.errLine('Error: syntax error, unexpected end of file');
      return 1;
    }
  });
})(window.NET);
