/*
 * services_cmd.js — прикладные сервисы: ssh и ключи, проверка конфигов
 * sshd/nginx, cron, openssl s_client.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var C = NET.cmdlib;
  var reg = NET.commands.register;
  var P = NET.packet;
  var E = NET.packet.E;

  function resolveHost(ctx, host) {
    var r = C.resolveTarget(ctx, host);
    return r.err ? { err: 'resolve' } : { ip: r.ip };
  }

  reg({
    name: 'ssh', category: 'services', summary: 'подключиться к другому хосту',
    usage: 'ssh [-v] [-p PORT] [-i KEY] [user@]host',
    complete: function (ctx, word, argv, h) {
      var out = h.hosts(ctx).concat(h.addrs(ctx));
      var u = ctx.user;
      return out.concat(h.hosts(ctx).map(function (n) { return u + '@' + n; }));
    },
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['v', 'vv', 'q', '4', '6', 'T'], value: ['p', 'i', 'o', 'l'] });
      var target = p.rest[0];
      if (!target) return ctx.usageError('usage: ssh [-p port] [user@]hostname [command]');
      var user = ctx.user, host = target;
      if (target.indexOf('@') > 0) {
        user = target.split('@')[0];
        host = target.split('@')[1];
      }
      var port = U.clampInt(p.opts.p, 22, 1, 65535);
      var res = resolveHost(ctx, host);
      if (res.err) return ctx.fail('ssh: Could not resolve hostname ' + host + ': Temporary failure in name resolution', 255);

      if (p.flags.v || p.flags.vv) {
        ctx.errLine('OpenSSH_9.6p1 Ubuntu-3ubuntu13, OpenSSL 3.0.13');
        ctx.errLine('debug1: Connecting to ' + host + ' [' + res.ip + '] port ' + port + '.');
      }
      var tcp = P.tcpConnect(ctx.world, ctx.machine, res.ip, port, { process: 'ssh' });
      var slow = !tcp.ok && (tcp.error === E.TIMEOUT || tcp.error === E.BLACKHOLE);
      return ctx.sleep(slow ? 1500 : 200).then(function () {
        if (!tcp.ok) {
          ctx.errLine('ssh: connect to host ' + host + ' port ' + port + ': ' +
            C.connectErrorText(tcp.error));
          return 255;
        }
        var node = tcp.dst.machine;
        var unit = node.services.get('ssh');
        if (!unit || unit.state !== 'active') {
          ctx.errLine('ssh: connect to host ' + host + ' port ' + port + ': Connection refused');
          return 255;
        }
        if (p.flags.v || p.flags.vv) {
          ctx.errLine('debug1: Connection established.');
          ctx.errLine('debug1: Remote protocol version 2.0, remote software version OpenSSH_9.6p1');
          ctx.errLine('debug1: Authenticating to ' + host + ':' + port + ' as \'' + user + '\'');
          ctx.errLine('debug1: Authentication succeeded (publickey).');
        }
        if (!node.users.byName(user)) {
          node.log('sshd', 'Invalid user ' + user + ' from ' + (tcp.hops[0] ? ctx.machine.net.primaryIP() : '?') + ' port ' + U.randInt(40000, 60000), 'err');
          ctx.errLine(user + '@' + host + ': Permission denied (publickey,password).');
          return 255;
        }
        if (!node.shell) {
          ctx.errLine(user + '@' + host + ': Permission denied (publickey,password).');
          return 255;
        }
        node.log('sshd', 'Accepted publickey for ' + user + ' from ' + ctx.machine.net.primaryIP() +
          ' port ' + U.randInt(40000, 60000) + ' ssh2');
        ctx.line('Welcome to Ubuntu ' + node.osRelease + ' (GNU/Linux ' + node.kernel + ' x86_64)');
        ctx.line('');
        ctx.line(' * Documentation:  https://help.ubuntu.com');
        ctx.line('Last login: ' + new Date().toString().slice(0, 24) + ' from ' + ctx.machine.net.primaryIP());
        ctx.world.setCurrent(node.name);
        var st = ctx.session.state(node);
        st.user = user;
        return 0;
      });
    }
  });

  reg({
    name: 'ssh-keygen', category: 'services', summary: 'создать SSH-ключ',
    usage: 'ssh-keygen -t ed25519 [-f FILE] [-N ""]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { value: ['t', 'f', 'N', 'C', 'b'], bool: ['y', 'l'] });
      var type = p.opts.t || 'rsa';
      var file = p.opts.f || (ctx.env.HOME + '/.ssh/id_' + type);
      var pub = file + '.pub';
      var fp = 'SHA256:' + U.uid('').slice(3) + U.uid('').slice(3);
      ctx.line('Generating public/private ' + type + ' key pair.');
      try {
        ctx.vfs.mkdir(ctx.env.HOME + '/.ssh', ctx.fsctx, { parents: true, mode: 0o700 });
        ctx.vfs.write(ctx.resolve(file), '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
          U.uid('b3BlbnNzaC1rZXktdjEAAAAABG5vbmU') + '\n-----END OPENSSH PRIVATE KEY-----\n',
          ctx.fsctx, { mode: 0o600 });
        ctx.vfs.chmod(ctx.resolve(file), 0o600, ctx.fsctx);
        ctx.vfs.write(ctx.resolve(pub), 'ssh-' + type + ' AAAAC3NzaC1lZDI1NTE5' + U.uid('') +
          ' ' + ctx.user + '@' + ctx.machine.hostname + '\n', ctx.fsctx, { mode: 0o644 });
      } catch (e) {
        return ctx.fail('Saving key "' + file + '" failed: ' + (e.message || 'Permission denied'), 1);
      }
      ctx.line('Your identification has been saved in ' + file);
      ctx.line('Your public key has been saved in ' + pub);
      ctx.line('The key fingerprint is:');
      ctx.line(fp + ' ' + ctx.user + '@' + ctx.machine.hostname);
      return 0;
    }
  });

  reg({
    name: 'ssh-copy-id', category: 'services', summary: 'скопировать ключ на удалённый хост',
    usage: 'ssh-copy-id [user@]host',
    run: function (ctx) {
      var target = ctx.argv[ctx.argv.length - 1];
      if (!target) return ctx.usageError('Usage: ssh-copy-id [-i keyfile] [user@]hostname');
      var user = ctx.user, host = target;
      if (target.indexOf('@') > 0) { user = target.split('@')[0]; host = target.split('@')[1]; }
      var res = resolveHost(ctx, host);
      if (res.err) return ctx.fail('ssh-copy-id: ERROR: Could not resolve hostname ' + host, 1);
      var tcp = P.tcpConnect(ctx.world, ctx.machine, res.ip, 22, {});
      if (!tcp.ok) return ctx.fail('ssh-copy-id: ERROR: ssh: connect to host ' + host + ' port 22: Connection refused', 1);
      var node = tcp.dst.machine;
      var key;
      try { key = ctx.vfs.read(ctx.env.HOME + '/.ssh/id_ed25519.pub', ctx.fsctx); }
      catch (e) {
        try { key = ctx.vfs.read(ctx.env.HOME + '/.ssh/id_rsa.pub', ctx.fsctx); }
        catch (e2) { return ctx.fail('ssh-copy-id: ERROR: No identities found', 1); }
      }
      var ru = node.users.byName(user);
      if (!ru) return ctx.fail('Permission denied (publickey,password).', 1);
      try {
        node.vfs.mkdir(ru.home + '/.ssh', NET.ROOTCTX, { parents: true, mode: 0o700 });
        node.vfs.write(ru.home + '/.ssh/authorized_keys', key, NET.ROOTCTX, { append: true, mode: 0o600 });
      } catch (e) {}
      ctx.line('Number of key(s) added: 1');
      ctx.line('');
      ctx.line('Now try logging into the machine, with:   "ssh \'' + user + '@' + host + '\'"');
      return 0;
    }
  });

  reg({
    name: 'sshd', category: 'services', summary: 'проверка конфигурации sshd', usage: 'sshd -t',
    run: function (ctx) {
      if (ctx.argv.indexOf('-t') < 0 && ctx.argv.indexOf('-T') < 0) {
        return ctx.fail('sshd: no hostkeys available -- exiting.', 1);
      }
      if (!ctx.isRoot) return ctx.fail('sshd: Permission denied', 1);
      var unit = ctx.machine.services.get('ssh');
      var err = unit && unit.preStart ? unit.preStart(ctx.machine, unit) : null;
      if (err) { ctx.errLine(err); return 1; }
      if (ctx.argv.indexOf('-T') >= 0) {
        try { ctx.out(ctx.vfs.read('/etc/ssh/sshd_config', ctx.fsctx)); } catch (e) {}
      }
      return 0;
    }
  });

  reg({
    name: 'nginx', category: 'services', summary: 'проверка конфигурации nginx', usage: 'nginx -t',
    run: function (ctx) {
      if (!ctx.isRoot) return ctx.fail('nginx: [emerg] open() "/run/nginx.pid" failed (13: Permission denied)', 1);
      if (ctx.argv.indexOf('-t') >= 0) {
        var unit = ctx.machine.services.get('nginx');
        var err = unit && unit.preStart ? unit.preStart(ctx.machine, unit) : null;
        if (err) { ctx.errLine(err); ctx.errLine('nginx: configuration file /etc/nginx/nginx.conf test failed'); return 1; }
        ctx.errLine('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok');
        ctx.errLine('nginx: configuration file /etc/nginx/nginx.conf test is successful');
        return 0;
      }
      if (ctx.argv.indexOf('-s') >= 0) {
        return NET.shell.invokeAs(ctx, ['systemctl', 'reload', 'nginx'], 'root');
      }
      ctx.errLine('nginx: [emerg] still could not bind()');
      return 1;
    }
  });

  reg({
    name: 'crontab', category: 'services', summary: 'задания cron', usage: 'crontab [-l|-e|-r]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['l', 'e', 'r'], value: ['u'] });
      var user = p.opts.u || ctx.user;
      var path = '/var/spool/cron/crontabs/' + user;
      if (p.flags.l) {
        var data;
        try { data = ctx.vfs.read(path, NET.ROOTCTX); }
        catch (e) { ctx.errLine('no crontab for ' + user); return 1; }
        ctx.out(data);
        return 0;
      }
      if (p.flags.r) {
        try { ctx.vfs.unlink(path, NET.ROOTCTX); } catch (e) {}
        return 0;
      }
      if (p.flags.e) {
        if (ctx.session.onEditor && ctx.streaming) {
          var current = '';
          try { current = ctx.vfs.read(path, NET.ROOTCTX); } catch (e) {
            current = '# m h  dom mon dow   command\n';
          }
          ctx.session.onEditor(path, current, 'root');
          return 0;
        }
      }
      ctx.errLine('usage: crontab [-u user] file | [-l | -r | -e]');
      return 1;
    }
  });

  reg({
    name: 'openssl', category: 'services', summary: 'проверка TLS-соединения',
    usage: 'openssl s_client -connect HOST:PORT',
    run: function (ctx) {
      if (ctx.argv[0] !== 's_client') {
        ctx.line('OpenSSL 3.0.13 30 Jan 2024');
        return 0;
      }
      var ci = ctx.argv.indexOf('-connect');
      var spec = ci >= 0 ? ctx.argv[ci + 1] : null;
      if (!spec) return ctx.usageError('usage: s_client -connect host:port');
      var host = spec.split(':')[0];
      var port = U.clampInt(spec.split(':')[1], 443, 1, 65535);
      var res = resolveHost(ctx, host);
      if (res.err) return ctx.fail('connect:errno=-2 (name resolution failed)', 1);
      var tcp = P.tcpConnect(ctx.world, ctx.machine, res.ip, port, {});
      var slow = !tcp.ok && tcp.error !== E.REFUSED;
      return ctx.sleep(slow ? 1400 : 150).then(function () {
        if (!tcp.ok) {
          ctx.errLine('connect:' + res.ip + ':' + port);
          ctx.errLine(tcp.error === E.REFUSED
            ? 'connect:errno=111 (Connection refused)'
            : 'connect:errno=110 (Connection timed out)');
          return 1;
        }
        ctx.line('CONNECTED(00000003)');
        ctx.line('depth=0 CN = ' + host);
        ctx.line('verify error:num=18:self-signed certificate');
        ctx.line('---');
        ctx.line('Certificate chain');
        ctx.line(' 0 s:CN = ' + host);
        ctx.line('   i:CN = ' + host);
        ctx.line('---');
        ctx.line('SSL handshake has read 1520 bytes and written 383 bytes');
        ctx.line('New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384');
        ctx.line('Verify return code: 18 (self signed certificate)');
        ctx.line('---');
        return 0;
      });
    }
  });

  reg({
    name: 'iperf3', category: 'net', summary: 'измерение пропускной способности',
    usage: 'iperf3 -c HOST',
    run: function (ctx) {
      var ci = ctx.argv.indexOf('-c');
      if (ci < 0) return ctx.usageError('iperf3: parameter error - must specify -c');
      var host = ctx.argv[ci + 1];
      var res = resolveHost(ctx, host);
      if (res.err) return ctx.fail('iperf3: error - unable to resolve host', 1);
      var tcp = P.tcpConnect(ctx.world, ctx.machine, res.ip, 5201, {});
      if (!tcp.ok) return ctx.fail('iperf3: error - unable to connect to server: ' +
        (tcp.error === E.REFUSED ? 'Connection refused' : 'Connection timed out'), 1);
      ctx.line('Connecting to host ' + host + ', port 5201');
      ctx.line('[  5] local ' + ctx.machine.net.primaryIP() + ' port ' + U.randInt(40000, 60000) + ' connected to ' + res.ip + ' port 5201');
      ctx.line('[ ID] Interval           Transfer     Bitrate         Retr  Cwnd');
      var i = 0;
      function step() {
        if (i >= 3) {
          ctx.line('- - - - - - - - - - - - - - - - - - - - - - - - -');
          ctx.line('[  5]   0.00-3.00   sec  ' + U.randInt(300, 700) + ' MBytes   ' + U.randInt(800, 950) + ' Mbits/sec  sender');
          return 0;
        }
        ctx.line('[  5]   ' + i + '.00-' + (i + 1) + '.00   sec  ' + U.randInt(100, 120) + ' MBytes  ' +
          U.randInt(850, 960) + ' Mbits/sec    0   ' + U.randInt(300, 900) + ' KBytes');
        i++;
        return ctx.sleep(400).then(step);
      }
      return step();
    }
  });
})(window.NET);
