/*
 * netcfg.js — постоянная конфигурация сети: Netplan и NetworkManager.
 *
 * Здесь живёт мини-парсер YAML (подмножество Netplan) с реалистичными
 * ошибками валидации и применение конфигурации к netstack. Важная учебная
 * механика: `netplan apply` переконфигурирует интерфейс с нуля, поэтому
 * ручные `ip addr add` теряются — как на настоящем сервере.
 */
(function (NET) {
  'use strict';

  var U = NET.util;

  /* ---------- YAML (подмножество) ---------- */

  function scalar(v) {
    if (v === '' || v === null || v === undefined) return null;
    var s = String(v).trim();
    if (s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
    if (s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1);
    if (s[0] === '[' && s[s.length - 1] === ']') {
      var inner = s.slice(1, -1).trim();
      if (!inner) return [];
      return inner.split(',').map(function (x) { return scalar(x.trim()); });
    }
    if (s[0] === '{' && s[s.length - 1] === '}') {
      var obj = {};
      s.slice(1, -1).split(',').forEach(function (pair) {
        var kv = pair.split(':');
        if (kv.length >= 2) obj[kv[0].trim()] = scalar(kv.slice(1).join(':').trim());
      });
      return obj;
    }
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
    if (s === 'null' || s === '~') return null;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    return s;
  }

  function parseYaml(text) {
    var errors = [];
    var items = [];
    String(text || '').split('\n').forEach(function (raw, i) {
      if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) return;
      if (/^\s*\t/.test(raw)) {
        errors.push({ line: i + 1, msg: 'found character \'\\t\' that cannot start any token' });
      }
      items.push({ indent: raw.match(/^ */)[0].length, text: raw.replace(/\s+$/, '').trim(), line: i + 1 });
    });

    var idx = 0;

    function parseBlock(indent) {
      var result = null;
      while (idx < items.length && items[idx].indent >= indent) {
        var it = items[idx];
        if (it.indent > indent) {
          errors.push({ line: it.line, msg: 'inconsistent indentation' });
          idx++;
          continue;
        }
        if (it.text.charAt(0) === '-') {
          if (result === null) result = [];
          if (!Array.isArray(result)) {
            errors.push({ line: it.line, msg: 'expected a mapping, got a sequence entry' });
            idx++;
            continue;
          }
          var rest = it.text.slice(1).trim();
          idx++;
          if (!rest) {
            var ni = idx < items.length ? items[idx].indent : -1;
            result.push(ni > it.indent ? parseBlock(ni) : null);
          } else if (/^[^:\s][^:]*:/.test(rest)) {
            var obj = {};
            var m = rest.match(/^([^:]+):\s*(.*)$/);
            obj[m[1].trim()] = scalar(m[2]);
            var ci = idx < items.length ? items[idx].indent : -1;
            if (ci > it.indent) {
              var sub = parseBlock(ci);
              if (sub && !Array.isArray(sub)) {
                Object.keys(sub).forEach(function (k) { obj[k] = sub[k]; });
              }
            }
            result.push(obj);
          } else {
            result.push(scalar(rest));
          }
          continue;
        }
        if (result === null) result = {};
        if (Array.isArray(result)) {
          errors.push({ line: it.line, msg: 'expected a sequence entry' });
          idx++;
          continue;
        }
        var km = it.text.match(/^([^:]+):\s*(.*)$/);
        if (!km) {
          errors.push({ line: it.line, msg: 'could not find expected \':\'' });
          idx++;
          continue;
        }
        var key = km[1].trim(), val = km[2].trim();
        idx++;
        /* ключи вроде __proto__ в конфигурации не имеют смысла и опасны
           при последующем слиянии объектов — отбрасываем с понятной ошибкой */
        if (NET.schema.isUnsafeKey(key)) {
          errors.push({ line: it.line, msg: 'недопустимый ключ \'' + key + '\'' });
          continue;
        }
        if (val === '') {
          var childIndent = idx < items.length ? items[idx].indent : -1;
          result[key] = childIndent > it.indent ? parseBlock(childIndent) : null;
        } else {
          result[key] = scalar(val);
        }
      }
      return result;
    }

    var root = items.length ? parseBlock(items[0].indent) : {};
    return { doc: root || {}, errors: errors };
  }

  /* ---------- рендеринг Netplan ---------- */

  function renderYaml(obj, indent) {
    indent = indent || 0;
    var pad = U.repeat(' ', indent);
    var lines = [];
    if (Array.isArray(obj)) {
      obj.forEach(function (v) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          var sub = renderYaml(v, indent + 2).split('\n');
          lines.push(pad + '- ' + sub[0].trim());
          sub.slice(1).forEach(function (l) { if (l.trim()) lines.push(l); });
        } else {
          lines.push(pad + '- ' + fmtScalar(v));
        }
      });
      return lines.join('\n');
    }
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v === null || v === undefined) { lines.push(pad + k + ':'); return; }
      if (Array.isArray(v)) {
        if (!v.length) { lines.push(pad + k + ': []'); return; }
        var allScalar = v.every(function (x) { return !x || typeof x !== 'object'; });
        if (allScalar) {
          lines.push(pad + k + ': [' + v.map(fmtScalar).join(', ') + ']');
        } else {
          lines.push(pad + k + ':');
          lines.push(renderYaml(v, indent + 2));
        }
        return;
      }
      if (typeof v === 'object') {
        lines.push(pad + k + ':');
        lines.push(renderYaml(v, indent + 2));
        return;
      }
      lines.push(pad + k + ': ' + fmtScalar(v));
    });
    return lines.join('\n');
  }

  function fmtScalar(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    if (v === null) return 'null';
    return String(v);
  }

  /* ---------- валидация и применение ---------- */

  var KNOWN_SECTIONS = ['ethernets', 'vlans', 'bonds', 'bridges', 'wifis', 'tunnels', 'dummy-devices'];

  function validate(doc) {
    var errs = [];
    if (!doc || !doc.network) {
      errs.push('Error in network definition: my file contains no network definitions');
      return errs;
    }
    var net = doc.network;
    if (net.version !== 2) {
      errs.push('Error in network definition: Expected `version: 2`');
    }
    if (net.renderer && ['networkd', 'NetworkManager'].indexOf(net.renderer) < 0) {
      errs.push('Error in network definition: unknown renderer \'' + net.renderer + '\'');
    }
    KNOWN_SECTIONS.forEach(function (sec) {
      var devs = net[sec];
      if (!devs) return;
      Object.keys(devs).forEach(function (name) {
        var d = devs[name] || {};
        (d.addresses || []).forEach(function (a) {
          if (typeof a !== 'string') return;
          if (a.indexOf('/') < 0) {
            errs.push('Error in network definition: address \'' + a + '\' is missing /prefixlength');
          } else {
            var c = U.parseCidr(a);
            if (!c && a.indexOf(':') < 0) {
              errs.push('Error in network definition: malformed address \'' + a + '\', must be X.X.X.X/NN');
            } else if (c && c.prefix > 32) {
              errs.push('Error in network definition: invalid prefix length in address \'' + a + '\'');
            }
          }
        });
        if (d.gateway4) {
          errs.push('** (generate:1): WARNING: `gateway4` has been deprecated, use default routes instead.');
        }
        (d.routes || []).forEach(function (r) {
          if (!r || (!r.to && !r.via)) {
            errs.push('Error in network definition: route must include either \'to\' or \'via\'');
          }
        });
        if (sec === 'vlans') {
          if (d.id === undefined) errs.push('Error in network definition: ' + name + ': missing \'id\' property');
          if (!d.link) errs.push('Error in network definition: ' + name + ': missing \'link\' property');
        }
        if (sec === 'bonds' && !d.interfaces) {
          errs.push('Error in network definition: ' + name + ': bond needs \'interfaces\'');
        }
      });
    });
    return errs;
  }

  /*
   * apply(world, machine, doc) — приводит стек к описанному состоянию.
   * Возвращает {ok, errors:[], changed:[]}
   */
  function apply(world, machine, doc) {
    var errors = validate(doc);
    var fatal = errors.filter(function (e) { return e.indexOf('WARNING') < 0; });
    if (fatal.length) return { ok: false, errors: errors };

    var net = machine.net;
    var netdef = doc.network;
    var changed = [];

    /* 1. Создаём виртуальные устройства из конфигурации */
    Object.keys(netdef.vlans || {}).forEach(function (name) {
      var d = netdef.vlans[name] || {};
      if (!net.getIface(name)) {
        net.addIface({ name: name, type: 'vlan', link: d.link, vlanId: d.id, mtu: d.mtu || 1500 });
      }
    });
    Object.keys(netdef.bonds || {}).forEach(function (name) {
      var d = netdef.bonds[name] || {};
      if (!net.getIface(name)) net.addIface({ name: name, type: 'bond', bondMode: (d.parameters || {}).mode || 'balance-rr' });
      (d.interfaces || []).forEach(function (sl) { net.setLink(sl, { master: name, up: true }); });
    });
    Object.keys(netdef.bridges || {}).forEach(function (name) {
      var d = netdef.bridges[name] || {};
      if (!net.getIface(name)) net.addIface({ name: name, type: 'bridge' });
      (d.interfaces || []).forEach(function (sl) { net.setLink(sl, { master: name, up: true }); });
    });

    /* 2. Применяем параметры ко всем описанным устройствам */
    var allNs = [], allSearch = [];
    KNOWN_SECTIONS.forEach(function (sec) {
      var devs = netdef[sec] || {};
      Object.keys(devs).forEach(function (name) {
        var d = devs[name] || {};
        var iface = net.getIface(name);
        if (!iface) {
          errors.push('netplan: WARNING: device ' + name + ' not found, skipping');
          return;
        }
        changed.push(name);

        /* Netplan переконфигурирует интерфейс целиком */
        net.flushAddrs(name);
        net.routes = net.routes.filter(function (r) {
          return r.dev !== name || r.proto === 'kernel';
        });

        if (d.mtu) net.setLink(name, { mtu: d.mtu });
        if (d.macaddress) net.setLink(name, { mac: d.macaddress });
        net.setLink(name, { up: true });
        iface.managedBy = (netdef.renderer === 'NetworkManager') ? 'NetworkManager' : 'networkd';

        (d.addresses || []).forEach(function (a) {
          var res = net.addAddr(name, a, {});
          if (res && res.err) errors.push('netplan: ' + res.err);
        });

        if (d.dhcp4 === true) {
          var r = NET.dhcp.request(world, machine, name);
          if (r.ok) {
            NET.dhcp.apply(world, machine, name, r.lease);
          } else {
            machine.log('systemd-networkd', name + ': DHCPv4 client: Failed to get lease, retrying', 'warning');
          }
        }

        (d.routes || []).forEach(function (r) {
          if (!r) return;
          var to = r.to === 'default' || r.to === '0.0.0.0/0' ? 'default' : r.to;
          var c = to === 'default' ? null : U.parseCidr(to);
          var res = net.addRoute({
            dst: to === 'default' ? 'default' : (c ? c.ip : to),
            prefix: c ? c.prefix : 0,
            gw: r.via || null, dev: name, metric: r.metric === undefined ? 100 : r.metric,
            proto: 'static', onlink: !!r['on-link'], table: r.table ? String(r.table) : 'main',
            family: (to.indexOf(':') >= 0 ? 6 : 4)
          });
          if (res && res.err) errors.push('netplan: ' + res.err + ' (route to ' + to + ')');
        });

        if (d.gateway4) {
          net.addRoute({ dst: 'default', gw: d.gateway4, dev: name, proto: 'static', metric: 100, family: 4 });
        }

        var ns = d.nameservers || {};
        (ns.addresses || []).forEach(function (a) { if (allNs.indexOf(a) < 0) allNs.push(a); });
        (ns.search || []).forEach(function (s) { if (allSearch.indexOf(s) < 0) allSearch.push(s); });
      });
    });

    /* 3. DNS: networkd пишет resolv.conf через systemd-resolved */
    if (allNs.length) {
      if (netdef.renderer === 'NetworkManager') {
        machine.setResolvConf(allNs, allSearch);
      } else {
        machine.resolved = machine.resolved || {};
        machine.resolved.upstream = allNs;
        machine.resolved.search = allSearch;
        if (machine.services.isActive('systemd-resolved')) {
          machine.setResolvConf(['127.0.0.53'], allSearch, true);
        } else {
          machine.setResolvConf(allNs, allSearch);
        }
      }
    }

    machine.log('systemd-networkd', 'netplan apply: configuration applied');
    return { ok: true, errors: errors, changed: changed };
  }

  /* Читает все файлы /etc/netplan/*.yaml и сливает их. */
  function loadFiles(machine) {
    var ctx = { uid: 0, gid: 0, groups: [0] };
    var files = [];
    try {
      files = machine.vfs.list('/etc/netplan', ctx).filter(function (e) {
        return /\.(yaml|yml)$/.test(e.name);
      });
    } catch (e) { return { doc: { network: { version: 2 } }, errors: [], files: [] }; }
    var merged = { network: { version: 2, renderer: 'networkd' } };
    var errors = [];
    files.forEach(function (f) {
      var text;
      try { text = machine.vfs.read(f.path, ctx); } catch (e) { return; }
      var p = parseYaml(text);
      p.errors.forEach(function (e) {
        errors.push(f.path + ':' + e.line + ': ' + e.msg);
      });
      var doc = p.doc || {};
      if (!doc.network) {
        if (Object.keys(doc).length) errors.push(f.path + ': missing top-level \'network:\' key');
        return;
      }
      NET.schema.safeKeys(doc.network).forEach(function (k) {
        if (KNOWN_SECTIONS.indexOf(k) >= 0) {
          merged.network[k] = merged.network[k] || {};
          NET.schema.safeKeys(doc.network[k] || {}).forEach(function (dev) {
            merged.network[k][dev] = doc.network[k][dev];
          });
        } else {
          merged.network[k] = doc.network[k];
        }
      });
    });
    return { doc: merged, errors: errors, files: files.map(function (f) { return f.path; }) };
  }

  /* ---------- NetworkManager ---------- */

  function nmApply(world, machine, conn) {
    var net = machine.net;
    var iface = net.getIface(conn.device);
    if (!iface) return { err: 'Error: unknown device \'' + conn.device + '\'.' };
    net.flushAddrs(conn.device);
    net.routes = net.routes.filter(function (r) {
      return r.dev !== conn.device || r.proto === 'kernel';
    });
    net.setLink(conn.device, { up: true, mtu: conn.mtu || undefined });
    iface.managedBy = 'NetworkManager';
    if (conn.method === 'auto') {
      var r = NET.dhcp.request(world, machine, conn.device);
      if (r.ok) NET.dhcp.apply(world, machine, conn.device, r.lease);
      else machine.log('NetworkManager', '<warn>  dhcp4 (' + conn.device + '): request timed out', 'warning');
    } else {
      (conn.addresses || []).forEach(function (a) { net.addAddr(conn.device, a, {}); });
      if (conn.gateway) {
        net.addRoute({ dst: 'default', gw: conn.gateway, dev: conn.device, proto: 'static', metric: 100, family: 4 });
      }
      if ((conn.dns || []).length) machine.setResolvConf(conn.dns, conn['dns-search'] || []);
    }
    (conn.routes || []).forEach(function (r) {
      var c = U.parseCidr(r.to);
      net.addRoute({ dst: c ? c.ip : r.to, prefix: c ? c.prefix : 32, gw: r.via, dev: conn.device, proto: 'static', metric: 100 });
    });
    conn.active = true;
    machine.log('NetworkManager', '<info>  [' + Date.now() + '] device (' + conn.device + '): Activation: successful, device activated.');
    return { ok: true };
  }

  function nmDown(machine, conn) {
    machine.net.flushAddrs(conn.device);
    machine.net.routes = machine.net.routes.filter(function (r) {
      return r.dev !== conn.device || r.proto === 'kernel';
    });
    machine.net.setLink(conn.device, { up: false });
    conn.active = false;
    return { ok: true };
  }

  NET.netcfg = {
    parseYaml: parseYaml,
    renderYaml: renderYaml,
    validate: validate,
    apply: apply,
    loadFiles: loadFiles,
    nmApply: nmApply,
    nmDown: nmDown
  };
})(window.NET);
