/*
 * lexer.js — разбор строки на токены с сохранением информации о кавычках.
 * Кавычки важны: 'a*' не раскрывается в glob, а "$VAR" не расщепляется.
 */
(function (NET) {
  'use strict';

  var OPS = ['2>>', '2>&1', '&>', '>>', '2>', '||', '&&', '|', '>', '<', ';', '&'];

  function tokenize(line) {
    var tokens = [];
    var i = 0;
    var parts = null;   // сегменты текущего слова
    var plain = '';     // накопитель обычного текста (важно для $VAR и $?)

    function addPart(text, quote) {
      if (!parts) parts = [];
      parts.push({ text: text, quote: quote || null });
    }
    function flushPlain() {
      if (plain) { addPart(plain, null); plain = ''; }
    }
    function pushWord() {
      flushPlain();
      if (parts) { tokens.push({ type: 'word', parts: parts }); parts = null; }
    }

    while (i < line.length) {
      var c = line[i];

      if (c === ' ' || c === '\t') { pushWord(); i++; continue; }

      if (c === '#' && !parts && !plain) break;      // комментарий до конца строки

      if (c === "'") {
        var end = line.indexOf("'", i + 1);
        if (end < 0) return { error: 'unexpected EOF while looking for matching `\'\'' };
        flushPlain();
        addPart(line.slice(i + 1, end), "'");
        i = end + 1;
        continue;
      }

      if (c === '"') {
        var buf = '';
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && i + 1 < line.length && '"\\$`'.indexOf(line[i + 1]) >= 0) {
            buf += line[i + 1]; i += 2; continue;
          }
          buf += line[i++];
        }
        if (i >= line.length) return { error: 'unexpected EOF while looking for matching `"\'' };
        i++;
        flushPlain();
        addPart(buf, '"');
        continue;
      }

      if (c === '\\') {
        if (i + 1 < line.length) { flushPlain(); addPart(line[i + 1], 'esc'); i += 2; }
        else i++;
        continue;
      }

      if (c === '$' && line[i + 1] === '(') {
        var depth = 1, j = i + 2, sub = '';
        while (j < line.length && depth > 0) {
          if (line[j] === '(') depth++;
          else if (line[j] === ')') { depth--; if (!depth) break; }
          sub += line[j++];
        }
        if (depth > 0) return { error: 'unexpected EOF while looking for matching `)\'' };
        flushPlain();
        addPart(sub, 'cmdsub');
        i = j + 1;
        continue;
      }

      if (c === '`') {
        var k = line.indexOf('`', i + 1);
        if (k < 0) return { error: 'unexpected EOF while looking for matching ``\'' };
        flushPlain();
        addPart(line.slice(i + 1, k), 'cmdsub');
        i = k + 1;
        continue;
      }

      var op = null;
      for (var o = 0; o < OPS.length; o++) {
        if (line.substr(i, OPS[o].length) === OPS[o]) { op = OPS[o]; break; }
      }
      if (op) {
        pushWord();
        tokens.push({ type: 'op', value: op });
        i += op.length;
        continue;
      }

      plain += c;
      i++;
    }
    pushWord();
    return { tokens: tokens };
  }

  NET.lexer = { tokenize: tokenize, OPS: OPS };
})(window.NET);
