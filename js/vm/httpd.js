/*
 * httpd.js — HTTP-уровень nginx на виртуальных хостах.
 *
 * Отдаёт страницы из node.http (внешние сайты) и статические файлы из
 * /var/www/html на машинах с полным образом, учитывает запреты вида
 * `location ~ /\. { deny all; }` из включённых сайтов, отвечает 400 на
 * попытки выйти из корня через ../ и пишет каждый запрос в
 * /var/log/nginx/access.log — одинаково для curl пользователя и для
 * запросов сценария атаки. Поэтому блокировка в firewall или правило
 * nginx сразу меняют и ответы, и журнал.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  var ROOT = { uid: 0, gid: 0, groups: [0], user: 'root' };
  var WEBROOT = '/var/www/html';
  var MAX_LOG = 256 * 1024;

  var NOT_FOUND = '<html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>\n';
  var FORBIDDEN = '<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>\n';
  var BAD = '<html><head><title>400 Bad Request</title></head><body><h1>400 Bad Request</h1></body></html>\n';

  function page(status, body) { return { status: status, body: body }; }

  /* location ~ REGEX { deny all; } / { return 404; } из sites-enabled */
  function denyRules(node) {
    var out = [];
    var dir = '/etc/nginx/sites-enabled';
    if (!node.vfs.exists(dir, ROOT)) return out;
    node.vfs.list(dir, ROOT).forEach(function (e) {
      var text = NET.errors.attempt('httpd.site', function () { return node.vfs.read(e.path, ROOT); }, '',
        { silent: true, level: 'warn' });
      var re = /location\s+(~\*?)\s+(\S+)\s*\{([^}]*)\}/g, m;
      while ((m = re.exec(String(text || ''))) !== null) {
        var body = m[3];
        var code = /deny\s+all\s*;/.test(body) ? 403 : null;
        var rm = body.match(/return\s+(\d{3})\s*;/);
        if (rm) code = Number(rm[1]);
        if (!code) continue;
        var rx = U.safeRegExp(m[2].replace(/^["']|["']$/g, ''), m[1] === '~*' ? 'i' : '');
        if (rx.re) out.push({ re: rx.re, code: code });
      }
    });
    return out;
  }

  function readable(node, path) {
    var n = node.vfs.get(path, ROOT);
    if (!n) return null;
    if (n.type === 'dir') return 'dir';
    var mode = n.mode || 0;
    var ok = (mode & 0o004) || (n.uid === 33 && (mode & 0o400)) || (n.gid === 33 && (mode & 0o040));
    return ok ? 'file' : 'denied';
  }

  /* Ответ сервера node на GET path (без сетевой части). */
  function serve(node, rawPath) {
    var path = String(rawPath || '/').split('?')[0];
    var pages = node.http || {};
    if (pages[path]) return pages[path];
    if (pages[path.replace(/\/$/, '')]) return pages[path.replace(/\/$/, '')];

    var decoded = path;
    try { decoded = decodeURIComponent(path); } catch (e) { return page(400, BAD); }
    /* nginx нормализует URI: выход за корень — 400, а не чтение /etc/passwd */
    var depth = 0, escape = false;
    decoded.split('/').forEach(function (seg) {
      if (seg === '..') { depth--; if (depth < 0) escape = true; } else if (seg && seg !== '.') depth++;
    });
    if (escape) return page(400, BAD);

    var fullImage = node.vfs.exists(WEBROOT, ROOT) && node.shell;
    if (!fullImage) {
      if (path === '/' && node.vfs.exists(WEBROOT + '/index.html', ROOT)) {
        return page(200, node.vfs.read(WEBROOT + '/index.html', ROOT));
      }
      return page(404, NOT_FOUND);
    }

    var rules = denyRules(node);
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].re.test(decoded)) return page(rules[i].code, rules[i].code === 403 ? FORBIDDEN : NOT_FOUND);
    }

    var fsPath = node.vfs.normalize(WEBROOT + '/' + decoded);
    if (fsPath.indexOf(WEBROOT) !== 0) return page(400, BAD);
    var kind = readable(node, fsPath);
    if (kind === 'dir') {
      fsPath = fsPath.replace(/\/$/, '') + '/index.html';
      kind = readable(node, fsPath);
    }
    if (kind === 'denied') return page(403, FORBIDDEN);
    if (kind !== 'file') return page(404, NOT_FOUND);
    var body = NET.errors.attempt('httpd.read', function () { return node.vfs.read(fsPath, ROOT); }, '',
      { silent: true, level: 'warn' });
    return page(200, String(body));
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function clf(ts) {
    var d = new Date(ts);
    return U.pad2(d.getDate()) + '/' + MONTHS[d.getMonth()] + '/' + d.getFullYear() + ':' +
      U.pad2(d.getHours()) + ':' + U.pad2(d.getMinutes()) + ':' + U.pad2(d.getSeconds()) + ' +0000';
  }

  /* Строка access.log в формате combined. */
  function logLine(src, method, path, status, size, ua, ts) {
    return src + ' - - [' + clf(ts || Date.now()) + '] "' + method + ' ' + path + ' HTTP/1.1" ' +
      status + ' ' + size + ' "-" "' + (ua || 'curl/8.5.0') + '"';
  }

  function log(node, src, method, path, status, size, ua) {
    var file = '/var/log/nginx/access.log';
    if (!node.shell || !node.vfs.exists('/var/log/nginx', ROOT)) return;
    NET.errors.attempt('httpd.log', function () {
      var cur = node.vfs.exists(file, ROOT) ? node.vfs.read(file, ROOT) : '';
      var next = cur + logLine(src, method, path, status, size, ua) + '\n';
      if (next.length > MAX_LOG) next = next.slice(next.length - MAX_LOG).replace(/^[^\n]*\n/, '');
      node.vfs.write(file, next, ROOT);
    }, null, { silent: true, level: 'warn' });
  }

  /*
   * Полный HTTP-запрос между машинами: TCP через движок пакетов (firewall,
   * маршруты, флуд), ответ сервера и запись в журнал. Для сценариев атак.
   */
  function request(world, from, ip, port, path, opts) {
    opts = opts || {};
    var tcp = NET.packet.tcpConnect(world, from, ip, port || 80, { srcIP: opts.srcIP });
    if (!tcp.ok) return { ok: false, error: tcp.error };
    var node = tcp.dst.machine;
    var unit = node.services.byPort(port || 80, 'tcp');
    if (unit && unit.state !== 'active') return { ok: false, error: NET.packet.E.REFUSED };
    var res = serve(node, path);
    log(node, opts.srcIP || (from.net.primaryIP && from.net.primaryIP()) || '0.0.0.0', opts.method || 'GET', path,
      res.status || 200, (res.body || '').length, opts.ua);
    return { ok: true, status: res.status || 200, body: res.body };
  }

  NET.httpd = { serve: serve, log: log, logLine: logLine, request: request };
})(window.NET);
