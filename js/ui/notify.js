/* notify.js — всплывающие уведомления */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};

  var host = null;

  function el() {
    if (!host) host = document.getElementById('toasts');
    return host;
  }

  function toast(kind, title, text, ttl) {
    var box = el();
    if (!box) return;
    var div = document.createElement('div');
    div.className = 'toast ' + (kind || 'info');
    var b = document.createElement('b');
    b.textContent = title;
    div.appendChild(b);
    if (text) {
      var span = document.createElement('span');
      span.textContent = text;
      div.appendChild(span);
    }
    box.appendChild(div);
    setTimeout(function () {
      div.style.opacity = '0';
      div.style.transition = 'opacity .25s';
      setTimeout(function () { if (div.parentNode) div.parentNode.removeChild(div); }, 260);
    }, ttl || 4200);
  }

  NET.ui.notify = {
    info: function (t, s) { toast('info', t, s); },
    ok: function (t, s) { toast('ok', t, s); },
    warn: function (t, s) { toast('warn', t, s); },
    err: function (t, s) { toast('err', t, s); },
    raw: toast
  };
})(window.NET);
