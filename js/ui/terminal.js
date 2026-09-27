/*
 * terminal.js — виджет терминала: вывод, ввод, история, автодополнение,
 * bash-совместимые сочетания клавиш и аккуратное прерывание по Ctrl+C.
 */
(function (NET) {
  'use strict';

  var U = NET.util;
  NET.ui = NET.ui || {};

  var MAX_NODES = NET.util.LIMITS.termNodes;

  var T = {
    session: null,
    busy: false,
    tabCount: 0,
    lastTabWord: null,
    search: null
  };

  function els() {
    return {
      scroll: document.getElementById('term-scroll'),
      out: document.getElementById('term-out'),
      prompt: document.getElementById('term-prompt'),
      input: document.getElementById('term-input'),
      status: document.getElementById('term-status-text'),
      exit: document.getElementById('term-status-exit')
    };
  }

  function atBottom() {
    var e = els().scroll;
    return e.scrollHeight - e.scrollTop - e.clientHeight < 60;
  }

  function scrollDown() {
    var e = els().scroll;
    e.scrollTop = e.scrollHeight;
  }

  /*
   * Вывод буферизуется и попадает в DOM одним куском за кадр.
   *
   * Раньше каждый ctx.line() создавал отдельный <span> и читал scrollHeight,
   * поэтому `find /` (тысячи строк) давал тысячи узлов и столько же
   * принудительных пересчётов раскладки. Теперь соседние куски одного стиля
   * склеиваются, layout измеряется один раз на сброс буфера, а терминал
   * остаётся отзывчивым при любом объёме вывода.
   */
  var queue = [];
  var queuedChars = 0;
  var flushScheduled = false;
  var lastNode = null;
  var lastCls = null;

  var raf = (window.requestAnimationFrame && window.requestAnimationFrame.bind(window)) ||
    function (fn) { return setTimeout(fn, 16); };

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    raf(function () { flushScheduled = false; flushNow(); });
  }

  function flushNow() {
    if (!queue.length) return;
    var e = els();
    var stick = atBottom();
    var items = queue;
    queue = [];
    queuedChars = 0;

    for (var i = 0; i < items.length; i++) {
      var cls = items[i].cls || '';
      var text = items[i].text;
      /* склеиваем подряд идущие куски одного стиля */
      while (i + 1 < items.length && (items[i + 1].cls || '') === cls) {
        text += items[++i].text;
      }
      var isLastChild = lastNode && lastNode.parentNode === e.out &&
        e.out.childNodes[e.out.childNodes.length - 1] === lastNode;
      if (isLastChild && lastCls === cls) {
        lastNode.textContent += text;
      } else {
        var span = document.createElement('span');
        span.className = 'chunk' + (cls ? ' ' + cls : '');
        span.textContent = text;
        e.out.appendChild(span);
        lastNode = span;
        lastCls = cls;
      }
    }

    while (e.out.childNodes.length > MAX_NODES) {
      var removed = e.out.firstChild;
      if (removed === lastNode) { lastNode = null; lastCls = null; }
      e.out.removeChild(removed);
    }
    if (stick) scrollDown();
  }

  /*
   * Санитизация вывода перед вставкой в DOM.
   * Разметка невозможна в принципе (только textContent), но управляющие
   * символы (\r, NUL, ESC) и bidi-переопределения способны испортить
   * раскладку строк и подделать видимый текст — показываем их явно,
   * как это делает cat -v.
   */
  var CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  var BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;

  function sanitize(s) {
    return s
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(CTRL_RE, function (c) {
        var code = c.charCodeAt(0);
        return code === 127 ? '^?' : '^' + String.fromCharCode(64 + code);
      })
      .replace(BIDI_RE, '\uFFFD');
  }

  function write(text, cls) {
    if (text === undefined || text === null) return;
    var s = sanitize(String(text));
    queue.push({ text: s, cls: cls || '' });
    queuedChars += s.length;
    /*
     * Пакетная запись нужна только пока команда работает и сыплет строками.
     * Одиночные сообщения (баннер, разбор лаборатории, подсказка) выводим
     * сразу: так они видны без задержки и не зависят от кадра отрисовки.
     */
    if (!T.busy || queuedChars > 65536) flushNow();
    else scheduleFlush();
  }

  function writeErr(text) { write(text, 'stderr'); }

  function clear() {
    queue = [];
    queuedChars = 0;
    lastNode = null;
    lastCls = null;
    els().out.textContent = '';
  }

  function promptSpans(p) {
    var frag = document.createDocumentFragment();
    function add(text, cls) {
      var s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      frag.appendChild(s);
    }
    add(p.user, 'p-user');
    add('@', 'p-sign');
    add(p.host, 'p-host');
    add(':', 'p-sign');
    add(p.cwd, 'p-path');
    add(p.sign + ' ', 'p-sign');
    return frag;
  }

  function refreshPrompt() {
    var e = els();
    var p = T.session.prompt();
    e.prompt.textContent = '';
    e.prompt.appendChild(promptSpans(p));
  }

  function echo(line) {
    flushNow();
    lastNode = null;
    var e = els();
    var p = T.session.prompt();
    var div = document.createElement('div');
    div.className = 'echo';
    div.appendChild(promptSpans(p));
    var cmd = document.createElement('span');
    cmd.className = 'p-cmd';
    cmd.textContent = line;
    div.appendChild(cmd);
    e.out.appendChild(div);
    scrollDown();
  }

  /*
   * Во время выполнения поле только для чтения, а не disabled: disabled-элемент
   * не получает события клавиатуры, и Ctrl+C перестал бы прерывать команду.
   */
  function setBusy(on, label) {
    T.busy = on;
    var e = els();
    e.input.readOnly = on;
    e.status.textContent = on ? (label || 'выполняется… Ctrl+C — прервать') : '';
    e.status.className = on ? 'running' : '';
    if (!on) setTimeout(function () { e.input.focus(); }, 0);
  }

  function setExit(code) {
    var e = els();
    e.exit.textContent = 'exit ' + code;
    e.exit.className = code === 0 ? 'exit-ok' : 'exit-bad';
  }

  /* ---------- запуск строки ---------- */

  function run(rawLine, opts) {
    opts = opts || {};
    var line = rawLine;
    if (T.busy) return Promise.resolve(1);
    var hist = T.session.history;
    if (/!/.test(line)) {
      var expanded = hist.expandBang(line);
      if (expanded !== line) { line = expanded; write(line + '\n', 'sys'); }
    }
    if (!opts.silent) echo(rawLine);
    if (line.trim()) hist.add(line);
    hist.reset();
    els().input.value = '';
    if (!line.trim()) { refreshPrompt(); return Promise.resolve(0); }

    T.session.aborted = false;
    setBusy(true);
    NET.bus.emit('terminal:run', { line: line });
    return NET.shell.run(T.session, line, {}).then(function (code) {
      flushNow();
      setBusy(false);
      setExit(code === undefined ? 0 : code);
      refreshPrompt();
      NET.bus.emit('terminal:done', { line: line, code: code });
      scrollDown();
      return code;
    }, function (err) {
      NET.errors.report(err, 'terminal.run');
      writeErr('internal error: ' + (err && err.message) + '\n');
      flushNow();
      setBusy(false);
      refreshPrompt();
      return 1;
    });
  }

  /* ---------- автодополнение ---------- */

  function complete() {
    var e = els();
    var line = e.input.value;
    var cursor = e.input.selectionStart === null ? line.length : e.input.selectionStart;
    var res = NET.completion.complete(T.session, line, cursor);
    if (!res.items.length) return;

    var word = res.word;
    if (res.items.length === 1) {
      var value = res.items[0].value;
      var suffix = res.items[0].isDir ? '' : ' ';
      e.input.value = line.slice(0, res.start) + value + suffix + line.slice(cursor);
      var pos = res.start + value.length + suffix.length;
      e.input.setSelectionRange(pos, pos);
      T.tabCount = 0;
      return;
    }
    if (res.common && res.common.length > word.length) {
      e.input.value = line.slice(0, res.start) + res.common + line.slice(cursor);
      var p2 = res.start + res.common.length;
      e.input.setSelectionRange(p2, p2);
      T.tabCount = 1;
      return;
    }
    T.tabCount++;
    if (T.tabCount >= 2) {
      echo(line);
      write(U.columns(res.items.map(function (i) { return i.display; }), 76) + '\n', 'completions');
      T.tabCount = 0;
      refreshPrompt();
    }
  }

  /* ---------- Ctrl+R ---------- */

  function startSearch() {
    T.search = { term: '', index: undefined };
    updateSearchStatus();
  }

  function updateSearchStatus() {
    var e = els();
    if (!T.search) { e.status.textContent = ''; return; }
    var found = T.session.history.search(T.search.term, T.search.index);
    e.status.textContent = "(reverse-i-search)`" + T.search.term + "': " + (found ? found.line : '');
    e.status.className = '';
    if (found) e.input.value = found.line;
  }

  function endSearch(accept) {
    if (!T.search) return;
    T.search = null;
    els().status.textContent = '';
    if (!accept) els().input.value = '';
  }

  /* ---------- клавиатура ---------- */

  function hasSelection(input) {
    try {
      if (input && input.selectionStart !== input.selectionEnd) return true;
      if (window.getSelection && String(window.getSelection()) !== '') return true;
    } catch (err) { /* getSelection может быть недоступен */ }
    return false;
  }

  function onKeyDown(e) {
    var input = els().input;
    var ctrl = e.ctrlKey || e.metaKey;

    if (T.search) {
      if (e.key === 'Escape') { endSearch(false); e.preventDefault(); return; }
      if (e.key === 'Enter') { endSearch(true); e.preventDefault(); run(input.value); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'r') {
        var found = T.session.history.search(T.search.term, (T.search.index === undefined
          ? T.session.history.items.length - 1 : T.search.index) - 1);
        if (found) T.search.index = found.index - 1;
        updateSearchStatus();
        e.preventDefault();
        return;
      }
      if (e.key === 'Backspace') {
        T.search.term = T.search.term.slice(0, -1);
        T.search.index = undefined;
        updateSearchStatus();
        e.preventDefault();
        return;
      }
      if (e.key.length === 1 && !ctrl) {
        T.search.term += e.key;
        T.search.index = undefined;
        updateSearchStatus();
        e.preventDefault();
        return;
      }
    }

    if (ctrl && e.key.toLowerCase() === 'c') {
      if (hasSelection(input)) return;     // выделен текст — это копирование
      if (T.busy) {
        T.session.aborted = true;
        write('^C\n', 'stderr');
      } else {
        echo(input.value + '^C');
        input.value = '';
        refreshPrompt();
      }
      e.preventDefault();
      return;
    }

    if (T.busy) { e.preventDefault(); return; }

    if (ctrl && e.key.toLowerCase() === 'l') { clear(); e.preventDefault(); return; }
    if (ctrl && e.key.toLowerCase() === 'u') {
      input.value = input.value.slice(input.selectionStart);
      input.setSelectionRange(0, 0);
      e.preventDefault(); return;
    }
    if (ctrl && e.key.toLowerCase() === 'k') {
      input.value = input.value.slice(0, input.selectionStart);
      e.preventDefault(); return;
    }
    if (ctrl && e.key.toLowerCase() === 'w') {
      var pos = input.selectionStart;
      var head = input.value.slice(0, pos).replace(/\S+\s*$/, '');
      input.value = head + input.value.slice(pos);
      input.setSelectionRange(head.length, head.length);
      e.preventDefault(); return;
    }
    if (ctrl && e.key.toLowerCase() === 'a') { input.setSelectionRange(0, 0); e.preventDefault(); return; }
    if (ctrl && e.key.toLowerCase() === 'e') {
      input.setSelectionRange(input.value.length, input.value.length);
      e.preventDefault(); return;
    }
    if (ctrl && e.key.toLowerCase() === 'r') { startSearch(); e.preventDefault(); return; }
    if (ctrl && e.key.toLowerCase() === 'd') {
      if (!input.value) { write('logout\n', 'sys'); }
      e.preventDefault(); return;
    }

    if (e.key === 'Enter') { run(input.value); e.preventDefault(); return; }
    if (e.key === 'Tab') { complete(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') {
      input.value = T.session.history.prev(input.value) || '';
      setTimeout(function () { input.setSelectionRange(input.value.length, input.value.length); }, 0);
      e.preventDefault(); return;
    }
    if (e.key === 'ArrowDown') {
      input.value = T.session.history.next() || '';
      e.preventDefault(); return;
    }
    if (e.key !== 'Tab') T.tabCount = 0;
  }

  /* ---------- приветствие ---------- */

  function banner() {
    var m = NET.world.machine();
    write('Linux Network Engineer Trainer ' + NET.version + ' — виртуальная Ubuntu, полностью офлайн\n', 'sys');
    write('Welcome to ' + m.osRelease + ' (GNU/Linux ' + m.kernel + ' x86_64)\n\n');
    write('  Хост: ' + m.hostname + '   Хранилище: ' + NET.storage.describe() + '\n');
    write('  Команды тренажёра: ');
    write('lab list', 'okline');
    write(' · ');
    write('lab start lab01', 'okline');
    write(' · ');
    write('check', 'okline');
    write(' · ');
    write('hint', 'okline');
    write(' · ');
    write('connect <host>', 'okline');
    write(' · ');
    write('help', 'okline');
    write('\n  Справка по команде: ');
    write('man ip', 'okline');
    write('   Горячие клавиши: ');
    write('?', 'okline');
    write(' или F1\n\n');
    write('Начните с ', 'dim');
    write('lab start lab01', 'okline');
    write(' — или просто осмотритесь: ', 'dim');
    write('ip -br a', 'okline');
    write(', ', 'dim');
    write('ip route', 'okline');
    write('\n\n', 'dim');
  }

  function init(session) {
    T.session = session;
    session.onOutput = function (text) { write(text); };
    session.onError = function (text) { writeErr(text); };
    session.onClear = function () { clear(); };
    session.onPager = function (text, title) { NET.ui.pager.open(text, title); };
    session.onEditor = function (path, content, user) { NET.ui.editor.open(path, content, user); };

    var e = els();
    e.input.addEventListener('keydown', onKeyDown);
    e.scroll.addEventListener('mousedown', function (ev) {
      /* клик по пустому месту возвращает фокус в ввод, не мешая выделению текста */
      if (ev.target === e.scroll || ev.target === e.out) {
        setTimeout(function () {
          if (!window.getSelection || String(window.getSelection()) === '') e.input.focus();
        }, 0);
      }
    });
    refreshPrompt();
    banner();
    setExit(0);
    e.input.focus();

    NET.bus.on('world:host-changed', refreshPrompt);
    NET.bus.on('shell:user-changed', refreshPrompt);
    NET.bus.on('machine:rebooted', refreshPrompt);
    NET.bus.on('world:restored', refreshPrompt);
  }

  NET.ui.terminal = {
    init: init,
    write: write,
    flush: flushNow,
    writeErr: writeErr,
    clear: clear,
    focus: function () { var i = els().input; if (i) i.focus(); },
    run: run,
    refreshPrompt: refreshPrompt,
    echo: echo,
    busy: function () { return T.busy; },
    session: function () { return T.session; }
  };
})(window.NET);
