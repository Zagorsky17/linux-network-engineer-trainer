/*
 * apt.js — управление пакетами. Работает «по-настоящему» в том смысле,
 * что без DNS и маршрута до archive.ubuntu.com apt честно падает с ошибкой.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;
  var P = NET.packet;

  var CATALOG = {
    'net-tools': { version: '2.10-0.1ubuntu4', size: 204, provides: ['ifconfig', 'netstat', 'route', 'arp'] },
    'iproute2': { version: '6.1.0-1ubuntu6', size: 1080, provides: ['ip', 'ss', 'bridge'] },
    'dnsutils': { version: '1:9.18.28-0ubuntu0.24.04.1', size: 340, provides: ['dig', 'nslookup', 'host'] },
    'bind9-dnsutils': { version: '1:9.18.28-0ubuntu0.24.04.1', size: 340, provides: ['dig'] },
    tcpdump: { version: '4.99.4-3ubuntu4', size: 1120, provides: ['tcpdump'] },
    nginx: { version: '1.24.0-2ubuntu7', size: 2240, provides: ['nginx'] },
    'openssh-server': { version: '1:9.6p1-3ubuntu13', size: 1420, provides: ['sshd'] },
    traceroute: { version: '1:2.1.3-1', size: 180, provides: ['traceroute'] },
    mtr: { version: '0.95-1', size: 240, provides: ['mtr'] },
    curl: { version: '8.5.0-2ubuntu10', size: 480, provides: ['curl'] },
    'isc-dhcp-client': { version: '4.4.3-P1-4ubuntu2', size: 640, provides: ['dhclient'] },
    nftables: { version: '1.0.9-1build1', size: 420, provides: ['nft'] },
    ufw: { version: '0.36.2-6', size: 780, provides: ['ufw'] },
    ethtool: { version: '1:6.7-1build1', size: 320, provides: ['ethtool'] },
    'network-manager': { version: '1.46.0-1ubuntu2', size: 4400, provides: ['nmcli'] }
  };

  function reachMirror(ctx) {
    var res = NET.dns.resolve(ctx.world, ctx.machine, 'archive.ubuntu.com', { type: 'A' });
    if (!res.ip) return { err: 'Temporary failure resolving \'archive.ubuntu.com\'', dns: true };
    var tcp = P.tcpConnect(ctx.world, ctx.machine, res.ip, 80, {});
    if (!tcp.ok) return { err: 'Could not connect to archive.ubuntu.com:80 (' + res.ip + '), connection failed', ip: res.ip };
    return { ok: true, ip: res.ip };
  }

  reg({
    name: 'apt', aliases: ['apt-get'], category: 'services', summary: 'пакеты',
    usage: 'apt {update|install|remove|list|show|policy} [PKG...]',
    complete: function (ctx, word, argv) {
      if (argv.length <= 1) return ['update', 'upgrade', 'install', 'remove', 'list', 'show', 'search', 'policy'];
      return Object.keys(CATALOG);
    },
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['y', 'q', 'installed', 'upgradable'] });
      var sub = p.rest[0];
      var pkgs = p.rest.slice(1);
      var needRoot = ['update', 'upgrade', 'install', 'remove', 'purge', 'autoremove'];

      if (!sub) {
        ctx.line('apt 2.7.14 (amd64)');
        ctx.line('Usage: apt [options] command');
        return 0;
      }
      if (needRoot.indexOf(sub) >= 0 && !ctx.isRoot) {
        ctx.errLine('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)');
        ctx.errLine('E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?');
        return 100;
      }

      if (sub === 'list') {
        Object.keys(CATALOG).sort().forEach(function (name) {
          ctx.line(name + '/noble,now ' + CATALOG[name].version + ' amd64 [installed]');
        });
        return 0;
      }
      if (sub === 'show' || sub === 'policy') {
        var name = pkgs[0];
        if (!CATALOG[name]) return ctx.fail('N: Unable to locate package ' + name);
        ctx.line('Package: ' + name);
        ctx.line('Version: ' + CATALOG[name].version);
        ctx.line('Priority: optional');
        ctx.line('Installed-Size: ' + CATALOG[name].size + ' kB');
        ctx.line('Provides: ' + (CATALOG[name].provides || []).join(', '));
        return 0;
      }

      var net = reachMirror(ctx);

      if (sub === 'update') {
        if (net.err) {
          ctx.line('Ign:1 http://archive.ubuntu.com/ubuntu noble InRelease');
          ctx.errLine('Err:1 http://archive.ubuntu.com/ubuntu noble InRelease');
          ctx.errLine('  ' + net.err);
          ctx.errLine('W: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  ' + net.err);
          ctx.errLine('W: Some index files failed to download. They have been ignored, or old ones used instead.');
          return 100;
        }
        return chain(ctx, [
          'Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease',
          'Get:2 http://archive.ubuntu.com/ubuntu noble-updates InRelease [126 kB]',
          'Get:3 http://security.ubuntu.com/ubuntu noble-security InRelease [126 kB]',
          'Fetched 252 kB in 1s (240 kB/s)',
          'Reading package lists... Done',
          'Building dependency tree... Done',
          'All packages are up to date.'
        ]);
      }

      if (sub === 'install' || sub === 'remove' || sub === 'purge') {
        if (!pkgs.length) return ctx.fail('E: Invalid operation ' + sub, 100);
        var unknown = pkgs.filter(function (n) { return !CATALOG[n]; });
        if (unknown.length) {
          ctx.errLine('E: Unable to locate package ' + unknown[0]);
          return 100;
        }
        if (sub === 'install' && net.err) {
          ctx.line('Reading package lists... Done');
          ctx.line('Building dependency tree... Done');
          ctx.errLine('E: Failed to fetch http://archive.ubuntu.com/ubuntu/pool/main/' +
            pkgs[0][0] + '/' + pkgs[0] + '/' + pkgs[0] + '_' + CATALOG[pkgs[0]].version + '_amd64.deb');
          ctx.errLine('  ' + net.err);
          ctx.errLine('E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?');
          return 100;
        }
        var lines = ['Reading package lists... Done', 'Building dependency tree... Done',
          'Reading state information... Done'];
        if (sub === 'install') {
          lines.push('The following NEW packages will be installed:');
          lines.push('  ' + pkgs.join(' '));
          lines.push('0 upgraded, ' + pkgs.length + ' newly installed, 0 to remove and 0 not upgraded.');
          lines.push('Need to get ' + pkgs.reduce(function (s, n) { return s + CATALOG[n].size; }, 0) + ' kB of archives.');
          pkgs.forEach(function (n, i) {
            lines.push('Get:' + (i + 1) + ' http://archive.ubuntu.com/ubuntu noble/main amd64 ' + n +
              ' amd64 ' + CATALOG[n].version + ' [' + CATALOG[n].size + ' kB]');
          });
          pkgs.forEach(function (n) {
            lines.push('Selecting previously unselected package ' + n + '.');
            lines.push('Unpacking ' + n + ' (' + CATALOG[n].version + ') ...');
            lines.push('Setting up ' + n + ' (' + CATALOG[n].version + ') ...');
          });
        } else {
          lines.push('The following packages will be REMOVED:');
          lines.push('  ' + pkgs.join(' '));
          pkgs.forEach(function (n) { lines.push('Removing ' + n + ' (' + CATALOG[n].version + ') ...'); });
        }
        return chain(ctx, lines);
      }

      if (sub === 'upgrade') {
        if (net.err) { ctx.errLine('E: ' + net.err); return 100; }
        return chain(ctx, ['Reading package lists... Done', 'Building dependency tree... Done',
          'Calculating upgrade... Done', '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.']);
      }

      if (sub === 'search') {
        var q = pkgs[0] || '';
        Object.keys(CATALOG).forEach(function (n) {
          if (n.indexOf(q) >= 0) {
            ctx.line(n + '/noble ' + CATALOG[n].version + ' amd64');
            ctx.line('  provides: ' + (CATALOG[n].provides || []).join(', '));
            ctx.line('');
          }
        });
        return 0;
      }

      return ctx.fail('E: Invalid operation ' + sub, 100);
    }
  });

  function chain(ctx, lines) {
    var i = 0;
    function step() {
      if (i >= lines.length) return 0;
      ctx.line(lines[i++]);
      return ctx.sleep(60).then(step);
    }
    return step();
  }

  reg({
    name: 'dpkg', category: 'services', summary: 'низкоуровневая работа с пакетами',
    usage: 'dpkg -l [PATTERN]',
    run: function (ctx) {
      var p = A.parse(ctx.argv, { bool: ['l', 'L'], value: ['s'] });
      if (p.flags.l) {
        ctx.line('Desired=Unknown/Install/Remove/Purge/Hold');
        ctx.line('| Status=Not/Inst/Conf-files/Unpacked/halF-conf/Half-inst/trig-aWait/Trig-pend');
        ctx.line('||/ Name                 Version              Architecture Description');
        ctx.line('+++-====================-====================-============-=================================');
        Object.keys(CATALOG).sort().forEach(function (n) {
          if (p.rest.length && n.indexOf(p.rest[0].replace(/\*/g, '')) < 0) return;
          ctx.line('ii  ' + U.padRight(n, 21) + U.padRight(CATALOG[n].version, 21) +
            U.padRight('amd64', 13) + (CATALOG[n].provides || []).join(', '));
        });
        return 0;
      }
      ctx.line('dpkg: need an action option');
      return 2;
    }
  });
})(window.NET);
