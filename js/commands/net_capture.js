/*
 * net_capture.js — tcpdump поверх кольцевого буфера пакетов.
 * Показывает ровно то, что прошло через модель: ARP без ответа, SYN без
 * SYN-ACK, DNS-запросы без ответа, ICMP frag needed и так далее.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var A = NET.cmdutil;
  var reg = NET.commands.register;

  reg({
    name: 'tcpdump', category: 'capture', summary: 'захват и анализ трафика',
    usage: 'tcpdump [-i IFACE] [-n] [-c N] [-e] [-vv] [expression]',
    complete: function (ctx, word, argv, h) {
      if (argv[argv.length - 1] === '-i') return h.ifaces(ctx).concat(['any']);
      return ['-i', '-n', '-c', '-e', '-vv', '-A', 'host', 'port', 'icmp', 'arp', 'tcp', 'udp', 'src', 'dst', 'net'];
    },
    run: function (ctx) {
      var p = A.parse(ctx.argv, {
        bool: ['n', 'nn', 'e', 'v', 'vv', 'A', 'q', 'l', 'X', 'S', 't'],
        value: ['i', 'c', 'w', 'r', 's']
      });
      if (!ctx.isRoot) {
        ctx.errLine('tcpdump: ' + (p.opts.i || 'ens33') + ': You don\'t have permission to capture on that device');
        ctx.errLine('(socket: Operation not permitted)');
        return 1;
      }
      var iface = p.opts.i || 'any';
      if (iface !== 'any' && !ctx.machine.net.getIface(iface)) {
        ctx.errLine('tcpdump: ' + iface + ': No such device exists');
        return 1;
      }
      var expr = p.rest.join(' ');
      var cap = ctx.world.capture;
      var recs = cap.query({ node: ctx.machine.name, iface: iface === 'any' ? null : iface, expr: expr });
      if (recs === null) {
        ctx.errLine('tcpdump: syntax error in filter expression: ' + expr);
        return 1;
      }
      var limit = NET.cmdlib.count(p.opts.c, 40, 500) || 40;
      var shown = recs.slice(-limit);

      ctx.errLine('tcpdump: verbose output suppressed, use -v[v]... for full protocol decode');
      ctx.errLine('listening on ' + iface + ', link-type EN10MB (Ethernet), snapshot length 262144 bytes');

      if (!shown.length) {
        return ctx.sleep(700).then(function () {
          ctx.errLine('^C');
          ctx.errLine('0 packets captured');
          ctx.errLine('0 packets received by filter');
          ctx.errLine('0 packets dropped by kernel');
          ctx.errLine('');
          ctx.errLine('(буфер пуст: сначала сгенерируйте трафик — ping/curl/dig — и повторите)');
          return 0;
        });
      }

      var i = 0;
      function step() {
        if (i >= shown.length || ctx.aborted()) {
          ctx.errLine('^C');
          ctx.errLine(shown.length + ' packets captured');
          ctx.errLine((shown.length + U.randInt(0, 4)) + ' packets received by filter');
          ctx.errLine('0 packets dropped by kernel');
          return 0;
        }
        ctx.line(cap.format(shown[i], { e: p.flags.e, v: p.flags.v || p.flags.vv }));
        i++;
        return ctx.sleep(35).then(step);
      }
      return step();
    }
  });
})(window.NET);
