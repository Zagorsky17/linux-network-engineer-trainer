/*
 * parser.js — из токенов в дерево: список пайплайнов с операторами && || ;
 * и редиректами каждой команды.
 */
(function (NET) {
  'use strict';

  function parse(tokens) {
    var list = [];           // [{pipeline, op}]
    var pipeline = { commands: [] };
    var cmd = { words: [], redirects: [] };
    var error = null;

    function endCmd() {
      if (cmd.words.length || cmd.redirects.length) pipeline.commands.push(cmd);
      cmd = { words: [], redirects: [] };
    }
    function endPipeline(op) {
      endCmd();
      if (pipeline.commands.length) list.push({ pipeline: pipeline, op: op || null });
      pipeline = { commands: [] };
    }

    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.type === 'word') { cmd.words.push(t); continue; }

      if (t.value === '|') { endCmd(); continue; }
      if (t.value === '&&' || t.value === '||' || t.value === ';' || t.value === '&') {
        endPipeline(t.value);
        continue;
      }
      if (t.value === '2>&1') {
        cmd.redirects.push({ type: 'dup', from: 2, to: 1 });
        continue;
      }
      /* редиректы требуют следующего слова */
      var next = tokens[i + 1];
      if (!next || next.type !== 'word') {
        error = 'syntax error near unexpected token `newline\'';
        break;
      }
      i++;
      var map = { '>': { fd: 1, append: false }, '>>': { fd: 1, append: true },
        '2>': { fd: 2, append: false }, '2>>': { fd: 2, append: true },
        '&>': { fd: 3, append: false }, '<': { fd: 0, append: false } };
      var r = map[t.value];
      cmd.redirects.push({
        type: t.value === '<' ? 'in' : 'out',
        fd: r.fd, append: r.append, target: next
      });
    }
    endPipeline(null);

    /* операторы принадлежат разделителю между элементами: сдвигаем */
    for (var j = 0; j < list.length - 1; j++) {
      list[j].next = list[j].op;
    }
    return { list: list, error: error };
  }

  NET.parser = { parse: parse };
})(window.NET);
