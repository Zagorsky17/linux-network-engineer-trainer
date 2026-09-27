/*
 * completion.js — Tab-автодополнение: команды, пути, подкоманды,
 * интерфейсы, юниты, хосты. Команда может дать свой completer.
 */
(function (NET) {
  'use strict';

  var U = NET.util;

  function splitLine(line, cursor) {
    var upto = line.slice(0, cursor);
    var words = upto.split(/\s+/);
    var current = words[words.length - 1];
    var start = cursor - current.length;
    return { words: words, current: current, start: start, upto: upto };
  }

  function completePath(ctx, word, opts) {
    opts = opts || {};
    var vfs = ctx.vfs;
    var dir, prefix;
    if (word.indexOf('/') >= 0) {
      var i = word.lastIndexOf('/');
      dir = word.slice(0, i) || '/';
      prefix = word.slice(i + 1);
    } else {
      dir = ctx.cwd;
      prefix = word;
    }
    if (dir[0] === '~') dir = (ctx.env.HOME || '/root') + dir.slice(1);
    var entries;
    try { entries = vfs.list(vfs.normalize(dir, ctx.cwd), ctx.fsctx); } catch (e) { return []; }
    var out = [];
    entries.forEach(function (e) {
      if (e.name.indexOf(prefix) !== 0) return;
      if (prefix[0] !== '.' && e.name[0] === '.') return;
      var isDir = e.node.type === 'dir';
      if (opts.dirsOnly && !isDir) return;
      var base = (word.indexOf('/') >= 0 ? word.slice(0, word.lastIndexOf('/') + 1) : '');
      out.push({ value: base + e.name + (isDir ? '/' : ''), display: e.name + (isDir ? '/' : ''), isDir: isDir });
    });
    return out;
  }

  function ifaceNames(ctx) {
    return ctx.machine.net.ifaces.map(function (i) { return i.name; });
  }

  function unitNames(ctx) {
    return ctx.machine.services.list().map(function (u) { return u.name + '.service'; });
  }

  function hostNames(ctx) {
    var out = [];
    ctx.world.each(function (m) { if (m.shell) out.push(m.name); });
    return out;
  }

  function knownHostsAndIps(ctx) {
    var out = [];
    ctx.world.each(function (m) {
      m.net.ifaces.forEach(function (i) {
        i.addrs.forEach(function (a) { if (a.family === 4 && a.scope !== 'host') out.push(a.ip); });
      });
    });
    return out.concat(['8.8.8.8', '1.1.1.1', 'example.com', 'www.example.com', 'corp.local',
      'srv1.corp.local', 'app1.corp.local', 'gw.corp.local', 'archive.ubuntu.com']);
  }

  /*
   * complete(session, line, cursor) -> {items:[], start, common}
   */
  function complete(session, line, cursor) {
    var ctx = NET.shell.makeCtx(session, {});
    var parts = splitLine(line, cursor);
    var word = parts.current;
    var isFirst = parts.words.filter(function (w) { return w !== ''; }).length <= 1 &&
      !/\s$/.test(parts.upto);

    var items = [];
    if (isFirst) {
      var names = NET.commands.names();
      items = names.filter(function (n) { return n.indexOf(word) === 0; })
        .map(function (n) { return { value: n, display: n }; });
      Object.keys(session.aliases).forEach(function (a) {
        if (a.indexOf(word) === 0) items.push({ value: a, display: a });
      });
    } else {
      var argv = parts.words.slice(0, -1).filter(function (w) { return w !== ''; });
      var cmd = NET.commands.get(argv[0]);
      if (cmd && cmd.complete) {
        var custom = cmd.complete(ctx, word, argv, {
          path: completePath, ifaces: ifaceNames, units: unitNames,
          hosts: hostNames, addrs: knownHostsAndIps
        }) || [];
        items = custom.map(function (c) {
          return typeof c === 'string' ? { value: c, display: c } : c;
        }).filter(function (c) { return c.value.indexOf(word) === 0; });
      } else {
        items = completePath(ctx, word);
      }
    }

    var common = U.commonPrefix(items.map(function (i) { return i.value; }));
    return { items: items, start: parts.start, word: word, common: common };
  }

  NET.completion = {
    complete: complete,
    path: completePath,
    ifaces: ifaceNames,
    units: unitNames,
    hosts: hostNames,
    addrs: knownHostsAndIps
  };
})(window.NET);
