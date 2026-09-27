/* Минимальный DOM для проверки UI-слоя в Node: ровно те возможности,
   которыми пользуется интерфейс тренажёра. */
const byId = new Map();

class ClassList {
  constructor(node) { this.node = node; }
  get set() { return new Set((this.node.className || '').split(/\s+/).filter(Boolean)); }
  _write(s) { this.node.className = Array.from(s).join(' '); }
  add(...c) { const s = this.set; c.forEach(x => s.add(x)); this._write(s); }
  remove(...c) { const s = this.set; c.forEach(x => s.delete(x)); this._write(s); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const has = this.contains(c);
    const want = force === undefined ? !has : !!force;
    if (want) this.add(c); else this.remove(c);
    return want;
  }
}

class Node {
  constructor(tag, ns) {
    this.tagName = (tag || '').toUpperCase();
    this.ns = ns || null;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.className = '';
    this.style = {};
    this.listeners = {};
    this._text = '';
    this.classList = new ClassList(this);
    this.scrollTop = 0; this.scrollHeight = 500; this.clientHeight = 300;
    this.value = ''; this.disabled = false; this.selectionStart = 0; this.title = '';
    this.options = [];
  }
  get id() { return this.attributes.id || ''; }
  set id(v) { this.setAttribute('id', v); }
  get firstChild() { return this.childNodes[0] || null; }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'id') byId.set(String(v), this);
  }
  getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; }
  appendChild(c) {
    if (c && c.__fragment) { c.childNodes.slice().forEach(x => this.appendChild(x)); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    if (this.tagName === 'SELECT' && c.tagName === 'OPTION') this.options.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map(c => c.textContent).join('');
  }
  set textContent(v) {
    this.childNodes.forEach(c => { c.parentNode = null; });
    this.childNodes = [];
    this._text = v === null || v === undefined ? '' : String(v);
  }
  set innerHTML(v) { this.textContent = ''; }
  addEventListener(name, fn) { (this.listeners[name] || (this.listeners[name] = [])).push(fn); }
  removeEventListener(name, fn) {
    const l = this.listeners[name] || [];
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  }
  dispatch(name, ev) {
    ev = ev || {};
    ev.target = ev.target || this;
    ev.preventDefault = ev.preventDefault || function () {};
    ev.stopPropagation = ev.stopPropagation || function () {};
    (this.listeners[name] || []).forEach(fn => fn(ev));
    return ev;
  }
  focus() { docObj.activeElement = this; }
  blur() {}
  setSelectionRange(a) { this.selectionStart = a; }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (matches(cur, sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    walk(this, n => { if (n !== this && matches(n, sel)) out.push(n); });
    out.forEach = Array.prototype.forEach.bind(out);
    return out;
  }
}

function walk(node, fn) {
  node.childNodes.forEach(c => { fn(c); walk(c, fn); });
}

function matches(node, sel) {
  sel = sel.trim();
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  const m = sel.match(/^([a-zA-Z]+)?(\[([^\]=]+)(=["']?([^\]"']*)["']?)?\])?$/);
  if (m) {
    if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
    if (m[3]) {
      const v = node.getAttribute(m[3]);
      if (v === null) return false;
      if (m[5] !== undefined && v !== m[5]) return false;
    }
    return true;
  }
  return false;
}

const docObj = {
  body: new Node('body'),
  activeElement: null,
  createElement(tag) { return new Node(tag); },
  createElementNS(ns, tag) { return new Node(tag, ns); },
  createDocumentFragment() { const f = new Node('fragment'); f.__fragment = true; return f; },
  createTextNode(t) { const n = new Node('#text'); n._text = t; return n; },
  getElementById(id) { return byId.get(id) || null; },
  querySelector(sel) { return docObj.body.querySelector(sel); },
  querySelectorAll(sel) { return docObj.body.querySelectorAll(sel); },
  addEventListener(name, fn) { (docObj.listeners[name] || (docObj.listeners[name] = [])).push(fn); },
  listeners: {},
  dispatch(name, ev) {
    ev = ev || {};
    ev.preventDefault = ev.preventDefault || function () {};
    (docObj.listeners[name] || []).forEach(fn => fn(ev));
    return ev;
  }
};

/* --- крошечный парсер подмножества HTML из index.html --- */
const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr']);
function parseHtml(html) {
  const bodyStart = html.indexOf('<body>');
  const bodyEnd = html.indexOf('</body>');
  const src = html.slice(bodyStart + 6, bodyEnd);
  const stack = [docObj.body];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^>"']+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    if (m[2]) {
      const tag = m[2].toLowerCase();
      const node = new Node(tag);
      const attrRe = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
      let a;
      while ((a = attrRe.exec(m[3] || ''))) node.setAttribute(a[1], a[2] === undefined ? '' : a[2]);
      stack[stack.length - 1].appendChild(node);
      if (!VOID.has(tag)) stack.push(node);
      continue;
    }
    if (m[4] && m[4].trim()) {
      const parent = stack[stack.length - 1];
      if (parent.childNodes.length === 0) parent._text = (parent._text || '') + m[4].trim();
      else parent.appendChild(docObj.createTextNode(m[4].trim()));
    }
  }
}

/* минимальные window-события и rAF: UI ими пользуется */
const windowListeners = {};
const windowApi = {
  addEventListener(name, fn) { (windowListeners[name] || (windowListeners[name] = [])).push(fn); },
  removeEventListener(name, fn) {
    const l = windowListeners[name] || [];
    const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  },
  dispatch(name, ev) { (windowListeners[name] || []).forEach(fn => fn(ev || {})); },
  requestAnimationFrame(fn) { return setTimeout(() => fn(Date.now()), 0); }
};

module.exports = { docObj, Node, parseHtml, byId, windowApi };
