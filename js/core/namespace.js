/*
 * Linux Network Engineer Trainer
 * namespace.js — единая глобальная точка сборки.
 *
 * ES-модули не используются намеренно: при запуске страницы по file://
 * Chrome блокирует <script type="module"> политикой CORS. Поэтому все файлы —
 * classic scripts, каждый оборачивается в IIFE и регистрируется в window.NET.
 */
(function (global) {
  'use strict';

  var NET = global.NET || (global.NET = {});

  NET.version = '1.0.0';
  NET.buildDate = '2026-09-27';

  /* Реестры, которые наполняются файлами при загрузке */
  NET.registries = {
    commands: {},   // name -> command def
    labs: {},       // id -> lab def
    topologies: {}, // id -> topology def
    theory: {},     // id -> theory card
    tasks: []       // короткие задания (pool)
  };

  /* Отложенные инициализаторы: выполняются один раз при старте приложения */
  NET._boot = [];
  NET.onBoot = function (fn) { NET._boot.push(fn); };
  NET.boot = function () {
    for (var i = 0; i < NET._boot.length; i++) {
      try { NET._boot[i](); } catch (e) {
        if (global.console) console.error('boot error', e);
      }
    }
  };
})(window);
