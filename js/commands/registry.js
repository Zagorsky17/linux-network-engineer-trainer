/*
 * registry.js — реестр команд.
 * Команда описывается объектом: имя, категория, usage, функция run и
 * (необязательно) собственный автокомплит. Новая команда = один register().
 */
(function (NET) {
  'use strict';

  var byName = NET.registries.commands;
  var aliases = {};
  var order = [];

  function register(def) {
    if (!def || !def.name) throw new Error('command needs a name');
    byName[def.name] = def;
    order.push(def.name);
    (def.aliases || []).forEach(function (a) { aliases[a] = def.name; });
    return def;
  }

  function get(name) {
    if (byName[name]) return byName[name];
    if (aliases[name]) return byName[aliases[name]];
    return null;
  }

  function names() {
    return order.slice().concat(Object.keys(aliases)).sort();
  }

  function byCategory() {
    var out = {};
    order.forEach(function (n) {
      var c = byName[n].category || 'misc';
      (out[c] || (out[c] = [])).push(byName[n]);
    });
    return out;
  }

  NET.commands = {
    register: register,
    get: get,
    names: names,
    byCategory: byCategory,
    all: function () { return order.map(function (n) { return byName[n]; }); }
  };
})(window.NET);

/*
 * cmdutil — разбор аргументов в стиле GNU: короткие флаги (в том числе
 * склеенные -la), длинные (--all), флаги со значением (-n 5, --lines=5).
 */
(function (NET) {
  'use strict';

  function parse(argv, spec) {
    spec = spec || {};
    var bool = spec.bool || [];
    var value = spec.value || [];
    var out = { flags: {}, opts: {}, rest: [], errors: [] };
    var i = 0;
    var stop = false;
    while (i < argv.length) {
      var a = argv[i];
      if (stop || a === '-' || a[0] !== '-') { out.rest.push(a); i++; continue; }
      if (a === '--') { stop = true; i++; continue; }
      if (a.indexOf('--') === 0) {
        var name = a.slice(2), val = null;
        var eq = name.indexOf('=');
        if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
        if (value.indexOf(name) >= 0) {
          if (val === null) { val = argv[++i]; }
          out.opts[name] = val;
        } else {
          out.flags[name] = true;
          if (val !== null) out.opts[name] = val;
        }
        i++;
        continue;
      }
      var chars = a.slice(1);
      var consumed = false;
      for (var c = 0; c < chars.length; c++) {
        var ch = chars[c];
        if (value.indexOf(ch) >= 0) {
          var v = chars.slice(c + 1);
          if (!v) { v = argv[++i]; }
          out.opts[ch] = v;
          consumed = true;
          break;
        }
        out.flags[ch] = true;
      }
      i++;
      if (consumed) continue;
    }
    return out;
  }

  function has(p, list) {
    for (var i = 0; i < list.length; i++) if (p.flags[list[i]]) return true;
    return false;
  }

  function num(v, def) {
    var n = parseInt(v, 10);
    return isNaN(n) ? def : n;
  }

  NET.cmdutil = { parse: parse, has: has, num: num };
})(window.NET);
