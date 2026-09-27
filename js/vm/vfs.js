/*
 * vfs.js — виртуальная файловая система.
 *
 * Дерево inode с настоящими правами доступа: обычный пользователь не прочитает
 * /etc/shadow, а `chmod 000 dir` действительно сломает обход каталога. Часть
 * узлов динамические (/proc, /sys) — их содержимое вычисляется из живого
 * состояния сетевого стека машины в момент чтения.
 */
(function (NET) {
  'use strict';

  function FsError(code, path, msg) {
    this.name = 'FsError';
    this.code = code;
    this.path = path;
    this.message = msg || FsError.messages[code] || code;
  }
  FsError.prototype = Object.create(Error.prototype);
  FsError.messages = {
    ENOSPC: 'No space left on device',
    EFBIG: 'File too large',
    ENOENT: 'No such file or directory',
    EEXIST: 'File exists',
    EISDIR: 'Is a directory',
    ENOTDIR: 'Not a directory',
    EACCES: 'Permission denied',
    ENOTEMPTY: 'Directory not empty',
    EPERM: 'Operation not permitted',
    EINVAL: 'Invalid argument',
    ELOOP: 'Too many levels of symbolic links'
  };

  var DIR = 'dir', FILE = 'file', LINK = 'link';

  function node(type, mode, uid, gid, extra) {
    var n = {
      type: type,
      mode: mode,
      uid: uid || 0,
      gid: gid || 0,
      mtime: Date.now(),
      nlink: 1
    };
    if (type === DIR) n.children = {};
    else if (type === LINK) n.target = extra || '';
    else n.content = extra === undefined ? '' : extra;
    return n;
  }

  function VFS(machine) {
    this.machine = machine || null;
    this.root = node(DIR, 0o755, 0, 0);
    this.umask = 0o022;
    this.nodeCount = 1;
    this.limits = {
      fileBytes: NET.util.LIMITS.fileBytes,
      nodes: NET.util.LIMITS.vfsNodes
    };
  }

  /* Песочница не безразмерна: без лимитов один `cat big > file` в пайплайне
     может съесть память вкладки. Ошибки те же, что отдаёт ядро. */
  VFS.prototype.checkQuota = function (path, addedBytes) {
    if (addedBytes !== undefined && addedBytes > this.limits.fileBytes) {
      throw new FsError('EFBIG', path);
    }
    if (this.nodeCount >= this.limits.nodes) {
      throw new FsError('ENOSPC', path);
    }
  };

  VFS.DIR = DIR; VFS.FILE = FILE; VFS.LINK = LINK;

  /* ---------- путь ---------- */

  VFS.prototype.normalize = function (path, cwd) {
    path = String(path === undefined ? '' : path);
    if (!path) path = cwd || '/';
    if (path[0] !== '/') path = (cwd || '/').replace(/\/$/, '') + '/' + path;
    var parts = path.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p === '.') continue;
      if (p === '..') { out.pop(); continue; }
      out.push(p);
    }
    return '/' + out.join('/');
  };

  VFS.prototype.basename = function (path) {
    var p = this.normalize(path);
    if (p === '/') return '/';
    return p.slice(p.lastIndexOf('/') + 1);
  };

  VFS.prototype.dirname = function (path) {
    var p = this.normalize(path);
    if (p === '/') return '/';
    var i = p.lastIndexOf('/');
    return i === 0 ? '/' : p.slice(0, i);
  };

  VFS.prototype.join = function (a, b) { return this.normalize(b, a); };

  /* ---------- права ---------- */

  function isRoot(ctx) { return !ctx || ctx.uid === 0; }

  VFS.prototype.can = function (n, ctx, what) {
    if (!n) return false;
    if (isRoot(ctx)) {
      // root игнорирует r/w, но x нужен хотя бы у кого-то (как в Linux)
      if (what === 'x') return !!(n.mode & 0o111) || n.type === DIR;
      return true;
    }
    var bits = { r: 4, w: 2, x: 1 }[what];
    var shift = (n.uid === ctx.uid) ? 6 : ((ctx.groups || [ctx.gid]).indexOf(n.gid) >= 0 ? 3 : 0);
    return ((n.mode >> shift) & bits) === bits;
  };

  /*
   * Обходит путь, проверяя +x на каждом каталоге.
   * Возвращает {node, parent, name, path} — node может быть null (нет файла).
   */
  VFS.prototype.walk = function (path, ctx, opts) {
    opts = opts || {};
    var abs = this.normalize(path, opts.cwd);
    var parts = abs === '/' ? [] : abs.slice(1).split('/');
    var cur = this.root, parent = null, name = '/';
    var depth = opts._depth || 0;

    for (var i = 0; i < parts.length; i++) {
      name = parts[i];
      if (cur.type === LINK) {
        cur = this._followLink(cur, parent, ctx, depth);
      }
      if (!cur) throw new FsError('ENOENT', abs);
      if (cur.type !== DIR) throw new FsError('ENOTDIR', abs);
      if (!this.can(cur, ctx, 'x')) throw new FsError('EACCES', abs);
      parent = cur;
      var next = cur.children[name];
      if (!next) {
        if (i === parts.length - 1) return { node: null, parent: parent, name: name, path: abs };
        throw new FsError('ENOENT', abs);
      }
      cur = next;
      var last = (i === parts.length - 1);
      if (cur.type === LINK && (!last || opts.follow !== false)) {
        var resolved = this._followLink(cur, parent, ctx, depth, last ? opts : null);
        if (!resolved && last) return { node: null, parent: parent, name: name, path: abs, dangling: true };
        cur = resolved;
      }
    }
    return { node: cur, parent: parent, name: name, path: abs };
  };

  VFS.prototype._followLink = function (link, parentDir, ctx, depth) {
    if (depth > 8) throw new FsError('ELOOP', link.target);
    var base = '/';
    // символические ссылки в образе задаём абсолютными — этого достаточно
    var target = link.target[0] === '/' ? link.target : this.normalize(link.target, base);
    try {
      var r = this.walk(target, ctx, { _depth: depth + 1 });
      return r.node;
    } catch (e) { return null; }
  };

  /* Возвращает узел или null, не бросая ENOENT (удобно для проверок). */
  VFS.prototype.get = function (path, ctx, opts) {
    try {
      var r = this.walk(path, ctx, opts);
      return r.node;
    } catch (e) { return null; }
  };

  VFS.prototype.exists = function (path, ctx) { return !!this.get(path, ctx); };

  VFS.prototype.isDir = function (path, ctx) {
    var n = this.get(path, ctx);
    return !!n && n.type === DIR;
  };

  /* ---------- чтение / запись ---------- */

  VFS.prototype.contentOf = function (n) {
    if (n.dyn) {
      try { return String(n.dyn(this.machine) || ''); } catch (e) { return ''; }
    }
    return n.content === undefined ? '' : n.content;
  };

  VFS.prototype.read = function (path, ctx, opts) {
    var r = this.walk(path, ctx, opts);
    if (!r.node) throw new FsError('ENOENT', r.path);
    if (r.node.type === DIR) throw new FsError('EISDIR', r.path);
    if (!this.can(r.node, ctx, 'r')) throw new FsError('EACCES', r.path);
    return this.contentOf(r.node);
  };

  VFS.prototype.write = function (path, data, ctx, opts) {
    opts = opts || {};
    var r = this.walk(path, ctx, opts);
    if (r.node) {
      if (r.node.type === DIR) throw new FsError('EISDIR', r.path);
      if (!this.can(r.node, ctx, 'w')) throw new FsError('EACCES', r.path);
      if (r.node.dyn) throw new FsError('EACCES', r.path);
      var next = opts.append ? this.contentOf(r.node) + data : String(data);
      if (next.length > this.limits.fileBytes) throw new FsError('EFBIG', r.path);
      r.node.content = next;
      r.node.mtime = Date.now();
      return r.node;
    }
    if (!this.can(r.parent, ctx, 'w')) throw new FsError('EACCES', r.path);
    this.checkQuota(r.path, String(data).length);
    var mode = (opts.mode === undefined ? 0o666 & ~this.umask : opts.mode);
    var n = node(FILE, mode, ctx ? ctx.uid : 0, ctx ? ctx.gid : 0, data);
    r.parent.children[r.name] = n;
    this.nodeCount++;
    r.parent.mtime = Date.now();
    return n;
  };

  VFS.prototype.touch = function (path, ctx) {
    var r = this.walk(path, ctx);
    if (r.node) { r.node.mtime = Date.now(); return r.node; }
    return this.write(path, '', ctx, { mode: 0o644 & ~this.umask });
  };

  VFS.prototype.mkdir = function (path, ctx, opts) {
    opts = opts || {};
    var abs = this.normalize(path, opts.cwd);
    if (opts.parents) {
      var parts = abs.slice(1).split('/');
      var cur = '';
      for (var i = 0; i < parts.length; i++) {
        cur += '/' + parts[i];
        if (!this.exists(cur, ctx)) this.mkdir(cur, ctx, { mode: opts.mode });
      }
      return this.get(abs, ctx);
    }
    var r = this.walk(abs, ctx);
    if (r.node) throw new FsError('EEXIST', abs);
    if (!this.can(r.parent, ctx, 'w')) throw new FsError('EACCES', abs);
    this.checkQuota(abs);
    var mode = opts.mode === undefined ? (0o777 & ~this.umask) : opts.mode;
    var n = node(DIR, mode, ctx ? ctx.uid : 0, ctx ? ctx.gid : 0);
    r.parent.children[r.name] = n;
    this.nodeCount++;
    return n;
  };

  VFS.prototype.symlink = function (target, path, ctx) {
    var r = this.walk(path, ctx, { follow: false });
    if (r.node) throw new FsError('EEXIST', r.path);
    this.checkQuota(r.path);
    var n = node(LINK, 0o777, ctx ? ctx.uid : 0, ctx ? ctx.gid : 0, target);
    r.parent.children[r.name] = n;
    this.nodeCount++;
    return n;
  };

  VFS.prototype.unlink = function (path, ctx, opts) {
    opts = opts || {};
    var r = this.walk(path, ctx, { follow: false, cwd: opts.cwd });
    if (!r.node && !r.dangling) throw new FsError('ENOENT', r.path);
    var target = r.node || r.parent.children[r.name];
    if (target && target.type === DIR && !opts.recursive) throw new FsError('EISDIR', r.path);
    if (target && target.type === DIR && Object.keys(target.children).length && !opts.recursive) {
      throw new FsError('ENOTEMPTY', r.path);
    }
    if (!this.can(r.parent, ctx, 'w')) throw new FsError('EACCES', r.path);
    this.nodeCount -= countNodes(target);
    delete r.parent.children[r.name];
    return true;
  };

  function countNodes(n) {
    if (!n) return 0;
    if (n.type !== DIR) return 1;
    var total = 1;
    Object.keys(n.children).forEach(function (k) { total += countNodes(n.children[k]); });
    return total;
  }

  VFS.prototype.rmdir = function (path, ctx) {
    var r = this.walk(path, ctx);
    if (!r.node) throw new FsError('ENOENT', r.path);
    if (r.node.type !== DIR) throw new FsError('ENOTDIR', r.path);
    if (Object.keys(r.node.children).length) throw new FsError('ENOTEMPTY', r.path);
    if (!this.can(r.parent, ctx, 'w')) throw new FsError('EACCES', r.path);
    this.nodeCount--;
    delete r.parent.children[r.name];
    return true;
  };

  VFS.prototype.rename = function (from, to, ctx, opts) {
    opts = opts || {};
    var src = this.walk(from, ctx, { follow: false, cwd: opts.cwd });
    if (!src.node) throw new FsError('ENOENT', src.path);
    var dst = this.walk(to, ctx, { follow: false, cwd: opts.cwd });
    if (dst.node && dst.node.type === DIR) {
      dst = this.walk(this.normalize(dst.path + '/' + src.name), ctx, { follow: false });
    }
    if (!this.can(dst.parent, ctx, 'w')) throw new FsError('EACCES', dst.path);
    if (!this.can(src.parent, ctx, 'w')) throw new FsError('EACCES', src.path);
    dst.parent.children[dst.name] = src.node;
    delete src.parent.children[src.name];
    return true;
  };

  VFS.prototype.copy = function (from, to, ctx, opts) {
    opts = opts || {};
    var src = this.walk(from, ctx, { cwd: opts.cwd });
    if (!src.node) throw new FsError('ENOENT', src.path);
    if (src.node.type === DIR && !opts.recursive) throw new FsError('EISDIR', src.path);
    var dst = this.walk(to, ctx, { follow: false, cwd: opts.cwd });
    if (dst.node && dst.node.type === DIR) {
      dst = this.walk(this.normalize(dst.path + '/' + src.name), ctx, { follow: false });
    }
    if (!this.can(dst.parent, ctx, 'w')) throw new FsError('EACCES', dst.path);
    if (!this.can(src.node, ctx, 'r')) throw new FsError('EACCES', src.path);
    var self = this;
    function cloneNode(n) {
      self.checkQuota(dst.path);
      self.nodeCount++;
      var c = node(n.type, n.mode, ctx ? ctx.uid : 0, ctx ? ctx.gid : 0);
      if (n.type === DIR) {
        Object.keys(n.children).forEach(function (k) { c.children[k] = cloneNode(n.children[k]); });
      } else if (n.type === LINK) c.target = n.target;
      else c.content = self.contentOf(n);
      return c;
    }
    dst.parent.children[dst.name] = cloneNode(src.node);
    return true;
  };

  VFS.prototype.list = function (path, ctx, opts) {
    opts = opts || {};
    var r = this.walk(path, ctx, { cwd: opts.cwd });
    if (!r.node) throw new FsError('ENOENT', r.path);
    if (r.node.type !== DIR) {
      return [{ name: this.basename(r.path), node: r.node, path: r.path }];
    }
    if (!this.can(r.node, ctx, 'r')) throw new FsError('EACCES', r.path);
    var self = this;
    return Object.keys(r.node.children).sort().map(function (k) {
      return { name: k, node: r.node.children[k], path: self.normalize(r.path + '/' + k) };
    });
  };

  VFS.prototype.chmod = function (path, mode, ctx, opts) {
    var r = this.walk(path, ctx, opts);
    if (!r.node) throw new FsError('ENOENT', r.path);
    if (!isRoot(ctx) && r.node.uid !== ctx.uid) throw new FsError('EPERM', r.path);
    r.node.mode = mode;
    return r.node;
  };

  VFS.prototype.chown = function (path, uid, gid, ctx, opts) {
    var r = this.walk(path, ctx, opts);
    if (!r.node) throw new FsError('ENOENT', r.path);
    if (!isRoot(ctx)) throw new FsError('EPERM', r.path);
    if (uid !== null && uid !== undefined) r.node.uid = uid;
    if (gid !== null && gid !== undefined) r.node.gid = gid;
    return r.node;
  };

  /* ---------- glob ---------- */

  function globToRe(pat) {
    var re = '';
    for (var i = 0; i < pat.length; i++) {
      var c = pat[i];
      if (c === '*') re += '[^/]*';
      else if (c === '?') re += '[^/]';
      else if (c === '[') {
        var j = pat.indexOf(']', i);
        if (j < 0) { re += '\\['; }
        else {
          var body = pat.slice(i + 1, j).replace(/^!/, '^');
          re += '[' + body + ']'; i = j;
        }
      } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
    /* шаблон приходит от пользователя: `ls [z-a]*` не должен ронять команду */
    var compiled = NET.util.safeRegExp('^' + re + '$');
    return compiled.re || /^\0$/;   // некорректный шаблон просто ни с чем не совпадает
  }

  /* Раскрывает шаблон в отсортированный список путей (пустой — значит нет совпадений). */
  VFS.prototype.glob = function (pattern, ctx, cwd) {
    var self = this;
    if (!/[*?\[]/.test(pattern)) return [];
    var abs = pattern[0] === '/' ? pattern : this.normalize(cwd || '/') + '/' + pattern;
    abs = abs.replace(/\/+/g, '/');
    var parts = abs.slice(1).split('/');
    var results = [''];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var next = [];
      for (var j = 0; j < results.length; j++) {
        var base = results[j] || '';
        if (!/[*?\[]/.test(part)) {
          var p = base + '/' + part;
          if (self.get(p, ctx)) next.push(p === '/' ? '' : p);
          continue;
        }
        var re = globToRe(part);
        var dir = base || '/';
        var entries;
        try { entries = self.list(dir, ctx); } catch (e) { continue; }
        entries.forEach(function (e) {
          if (part[0] !== '.' && e.name[0] === '.') return;  // скрытые файлы как в bash
          if (re.test(e.name)) next.push(base + '/' + e.name);
        });
      }
      results = next;
    }
    return results.filter(Boolean).sort();
  };

  /* Рекурсивный обход для find/du/tree. */
  VFS.prototype.walkTree = function (path, ctx, cb, depth) {
    var r;
    try { r = this.walk(path, ctx); } catch (e) { return; }
    if (!r.node) return;
    cb(r.path, r.node, depth || 0);
    if (r.node.type === DIR && this.can(r.node, ctx, 'r')) {
      var self = this;
      Object.keys(r.node.children).sort().forEach(function (k) {
        self.walkTree(self.normalize(r.path + '/' + k), ctx, cb, (depth || 0) + 1);
      });
    }
  };

  /* ---------- вывод в стиле ls -l ---------- */

  VFS.prototype.modeString = function (n) {
    var t = n.type === DIR ? 'd' : (n.type === LINK ? 'l' : '-');
    var rwx = ['', '', ''];
    for (var i = 0; i < 3; i++) {
      var bits = (n.mode >> ((2 - i) * 3)) & 7;
      rwx[i] = ((bits & 4) ? 'r' : '-') + ((bits & 2) ? 'w' : '-') + ((bits & 1) ? 'x' : '-');
    }
    return t + rwx.join('');
  };

  VFS.prototype.size = function (n) {
    if (n.type === DIR) return 4096;
    if (n.type === LINK) return n.target.length;
    return this.contentOf(n).length;
  };

  /* ---------- сериализация (снапшоты мира) ---------- */

  VFS.prototype.snapshot = function () {
    function ser(n) {
      var o = { t: n.type, m: n.mode, u: n.uid, g: n.gid, mt: n.mtime };
      if (n.dyn) { o.dyn = true; return o; }          // динамику не сохраняем
      if (n.type === DIR) {
        o.c = {};
        Object.keys(n.children).forEach(function (k) { o.c[k] = ser(n.children[k]); });
      } else if (n.type === LINK) o.tg = n.target;
      else o.d = n.content;
      return o;
    }
    return { umask: this.umask, root: ser(this.root) };
  };

  VFS.prototype.restore = function (snap, dynIndex) {
    var self = this;
    function de(o, path) {
      var n = node(o.t, o.m, o.u, o.g);
      n.mtime = o.mt;
      if (o.dyn && dynIndex && dynIndex[path]) n.dyn = dynIndex[path];
      else if (o.t === DIR) {
        Object.keys(o.c || {}).forEach(function (k) {
          n.children[k] = de(o.c[k], (path === '/' ? '' : path) + '/' + k);
        });
      } else if (o.t === LINK) n.target = o.tg;
      else n.content = o.d;
      return n;
    }
    this.umask = snap.umask;
    this.root = de(snap.root, '/');
    this.nodeCount = countNodes(this.root);
  };

  /* Индекс динамических узлов, чтобы восстановить их после снапшота. */
  VFS.prototype.dynIndex = function () {
    var idx = {};
    this.walkTree('/', null, function (p, n) { if (n.dyn) idx[p] = n.dyn; });
    return idx;
  };

  NET.FsError = FsError;
  NET.VFS = VFS;
  NET.vfsNode = node;
})(window.NET);
