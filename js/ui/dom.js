/*
 * dom.js — маленький слой построения DOM.
 *
 * Политика безопасности интерфейса: текст всегда попадает в документ через
 * textContent и createElement. innerHTML/insertAdjacentHTML в приложении
 * не используются, поэтому ни имя файла, ни вывод команды, ни импортированный
 * профиль не могут превратиться в разметку или скрипт.
 * Раньше каждая панель определяла свой h() — теперь помощник один.
 */
(function (NET) {
  'use strict';

  NET.ui = NET.ui || {};

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function text(value) {
    return document.createTextNode(value === undefined || value === null ? '' : String(value));
  }

  function clear(node) {
    if (!node) return node;
    node.textContent = '';
    return node;
  }

  function append(parent) {
    for (var i = 1; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      parent.appendChild(typeof child === 'string' ? text(child) : child);
    }
    return parent;
  }

  /* Кнопка с необязательной подсказкой горячей клавиши. */
  function button(label, kbd, cls, onClick) {
    var b = h('button', 'btn ' + (cls || ''));
    b.appendChild(text(label));
    if (kbd) b.appendChild(h('kbd', null, kbd));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function chip(label, cls) {
    return h('span', 'chip' + (cls ? ' ' + cls : ''), label);
  }

  /* Чип уровня с цветной точкой. */
  function levelChip(level, label, cls) {
    var c = h('span', 'chip' + (cls ? ' ' + cls : ''));
    c.appendChild(h('span', 'level-dot level-' + level));
    c.appendChild(text(' ' + label));
    return c;
  }

  function byId(id) { return document.getElementById(id); }

  NET.ui.dom = {
    h: h,
    text: text,
    clear: clear,
    append: append,
    button: button,
    chip: chip,
    levelChip: levelChip,
    byId: byId
  };
})(window.NET);
