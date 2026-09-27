/*
 * expand.js — раскрытие слов: ~, $VAR, $(...), wildcard, расщепление.
 * Возвращает Promise, потому что $( ) требует запуска подкоманды.
 */
(function (NET) {
  'use strict';

  function expandWord(token, ctx, runSub) {
    var pieces = [];   // [{text, glob:bool, split:bool}]
    var chain = Promise.resolve();

    token.parts.forEach(function (part, index) {
      chain = chain.then(function () {
        if (part.quote === "'") { pieces.push({ text: part.text, glob: false, split: false }); return; }
        if (part.quote === 'esc') { pieces.push({ text: part.text, glob: false, split: false }); return; }
        if (part.quote === 'cmdsub') {
          return runSub(part.text).then(function (out) {
            pieces.push({ text: String(out).replace(/\n+$/, ''), glob: false, split: true });
          });
        }
        var text = substVars(part.text, ctx);
        if (part.quote === '"') pieces.push({ text: text, glob: false, split: false });
        else {
          var raw = part.text;
          var hadVar = /\$/.test(raw);
          pieces.push({ text: text, glob: /[*?\[]/.test(raw), split: hadVar, first: index === 0 });
        }
      });
    });

    return chain.then(function () {
      var joined = pieces.map(function (p) { return p.text; }).join('');
      var globable = pieces.some(function (p) { return p.glob; });
      var splittable = pieces.some(function (p) { return p.split; });

      /* ~ только в начале слова и без кавычек */
      if (token.parts.length && !token.parts[0].quote && /^~/.test(joined)) {
        var home = ctx.env.HOME || '/root';
        if (joined === '~' || joined.indexOf('~/') === 0) joined = home + joined.slice(1);
      }

      var words = splittable ? joined.split(/\s+/).filter(function (w) { return w !== ''; }) : [joined];
      if (!words.length) words = splittable ? [] : [joined];

      if (!globable) return words;

      var out = [];
      words.forEach(function (w) {
        var matches = ctx.machine.vfs.glob(w, ctx.fsctx, ctx.cwd);
        if (matches.length) out = out.concat(matches);
        else out.push(w);   // bash оставляет шаблон как есть
      });
      return out;
    });
  }

  function substVars(text, ctx) {
    return String(text).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\?|\$\$|\$!/g,
      function (m, braced, plain) {
        if (m === '$?') return String(ctx.session.lastExit || 0);
        if (m === '$$') return String(ctx.session.shellPid || 1234);
        if (m === '$!') return String(ctx.session.lastBg || '');
        var name = braced || plain;
        if (name === undefined) return m;
        var v = ctx.env[name];
        return v === undefined ? '' : String(v);
      });
  }

  function expandWords(tokens, ctx, runSub) {
    var out = [];
    var chain = Promise.resolve();
    tokens.forEach(function (t) {
      chain = chain.then(function () {
        return expandWord(t, ctx, runSub).then(function (words) {
          out = out.concat(words);
        });
      });
    });
    return chain.then(function () { return out; });
  }

  NET.expand = { expandWords: expandWords, expandWord: expandWord, substVars: substVars };
})(window.NET);
