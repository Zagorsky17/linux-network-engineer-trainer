/*
 * panel_topology.js — SVG-схема топологии.
 *
 * Схема подсвечивает только то, что пользователь проверил сам: успешная
 * проба — зелёный контур, неудачная — красный, непроверенное — серый.
 * Так формируется привычка идти по пути пакета, а не угадывать.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};

  var SVG = 'http://www.w3.org/2000/svg';
  var probes = {};   // nodeId -> true/false

  function el(name, attrs) {
    var e = document.createElementNS(SVG, name);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }

  function nodeForIp(ip) {
    if (!ip || !NET.world) return null;
    var found = null;
    NET.world.each(function (m) {
      if (found) return;
      if (m.net.ownsIP(ip)) found = m.name;
    });
    return found;
  }

  NET.bus.on('probe:result', function (ev) {
    var id = nodeForIp(ev.ip);
    if (!id) return;
    probes[id] = !!ev.ok;
    render();
  });

  NET.bus.on('lab:started', function () { probes = {}; render(); });
  NET.bus.on('lab:reset', function () { probes = {}; render(); });
  NET.bus.on('world:host-changed', render);
  NET.bus.on('world:rebuilt', function () { probes = {}; render(); });

  function linkDown(link) {
    var world = NET.world;
    var bad = false;
    [link.from, link.to].forEach(function (id) {
      var m = world.get(id);
      if (!m) return;
      m.net.ifaces.forEach(function (i) {
        if (i.segment !== link.seg) return;
        if (!m.net.operational(i)) bad = true;
      });
    });
    return bad;
  }

  function nodeInfo(id) {
    var m = NET.world.get(id);
    if (!m) return null;
    var addrs = [];
    m.net.ifaces.forEach(function (i) {
      if (i.type === 'loopback') return;
      i.addrs.forEach(function (a) { if (a.family === 4) addrs.push(a.ip + '/' + a.prefix); });
    });
    return {
      hostname: m.hostname,
      addrs: addrs,
      up: m.net.ifaces.some(function (i) { return i.type !== 'loopback' && m.net.operational(i); })
    };
  }

  function render() {
    var wrap = document.getElementById('topo-wrap');
    if (!wrap || !NET.world || !NET.world.diagram) return;
    var d = NET.world.diagram;
    wrap.textContent = '';

    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    d.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    });
    var pad = 24;
    var svg = el('svg', {
      width: (maxX - minX) + pad * 2,
      height: (maxY - minY) + pad * 2,
      viewBox: (minX - pad) + ' ' + (minY - pad) + ' ' + ((maxX - minX) + pad * 2) + ' ' + ((maxY - minY) + pad * 2)
    });

    var byId = {};
    d.nodes.forEach(function (n) { byId[n.id] = n; });

    d.links.forEach(function (link) {
      var a = byId[link.from], b = byId[link.to];
      if (!a || !b) return;
      var x1 = a.x + a.w / 2, y1 = a.y + a.h / 2;
      var x2 = b.x + b.w / 2, y2 = b.y + b.h / 2;
      svg.appendChild(el('line', {
        x1: x1, y1: y1, x2: x2, y2: y2,
        class: 'topo-link' + (linkDown(link) ? ' down' : '')
      }));
    });

    d.nodes.forEach(function (n) {
      var info = nodeInfo(n.id);
      var cls = 'topo-node role-' + (n.role || 'host');
      if (NET.world.current === n.id) cls += ' current';
      if (probes[n.id] === true) cls += ' probe-ok';
      if (probes[n.id] === false) cls += ' probe-bad';
      var g = el('g', { class: cls });
      g.appendChild(el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 6 }));
      var lines = n.label.split('\n');
      lines.forEach(function (text, i) {
        var t = el('text', {
          x: n.x + n.w / 2, y: n.y + 17 + i * 13,
          'text-anchor': 'middle', class: i ? 'sub' : ''
        });
        t.textContent = text;
        g.appendChild(t);
      });
      if (info) {
        var title = el('title');
        title.textContent = info.hostname + '\n' + (info.addrs.join('\n') || 'без адресов') +
          '\n' + (info.up ? 'интерфейсы UP' : 'нет активных интерфейсов');
        g.appendChild(title);
        if (NET.world.get(n.id) && NET.world.get(n.id).shell) {
          g.style.cursor = 'pointer';
          g.addEventListener('click', function () {
            NET.world.setCurrent(n.id);
            NET.ui.terminal.write('[переключение на ' + info.hostname + ']\n', 'sys');
            NET.ui.terminal.refreshPrompt();
            NET.ui.app.updateTopbar();
            render();
          });
        }
      }
      svg.appendChild(g);
    });

    wrap.appendChild(svg);

    var legend = document.createElement('div');
    legend.className = 'topo-legend';
    legend.textContent = 'Контур узла: зелёный — ваша проверка прошла, красный — не прошла, серый — ещё не проверяли. ' +
      'Пунктирная линия — интерфейс на этом участке down. Клик по узлу с консолью переключает хост.';
    wrap.appendChild(legend);
  }

  NET.ui.topology = { render: render, probes: function () { return probes; } };
})(window.NET);
