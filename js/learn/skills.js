/*
 * skills.js — карта навыков и расчёт уровня.
 *
 * Уровень считается не по числу «пройденных уроков», а по результатам:
 * объём решённых задач × качество × сложность × самостоятельность.
 */
(function (NET) {
  'use strict';

  var SKILLS = [
    { id: 'linux', title: 'Linux fundamentals', desc: 'ФС, процессы, пакеты, systemd' },
    { id: 'cli', title: 'CLI', desc: 'пайплайны, фильтры, скорость работы в консоли' },
    { id: 'networking', title: 'Networking', desc: 'интерфейсы, адресация, ARP, L2/L3' },
    { id: 'routing', title: 'Routing', desc: 'таблицы маршрутов, шлюзы, longest prefix match' },
    { id: 'dns', title: 'DNS', desc: 'резолвинг, зоны, кеш, systemd-resolved' },
    { id: 'dhcp', title: 'DHCP', desc: 'аренда адресов, DISCOVER/OFFER, отладка' },
    { id: 'firewall', title: 'Firewall', desc: 'netfilter, ufw, iptables, nft' },
    { id: 'security', title: 'Security', desc: 'SSH, права, sudo, безопасный доступ' },
    { id: 'troubleshooting', title: 'Troubleshooting', desc: 'методика поиска причины' },
    { id: 'tcpip', title: 'TCP/IP', desc: 'порты, сокеты, MTU, handshake' },
    { id: 'packet', title: 'Packet analysis', desc: 'tcpdump, фильтры, чтение дампов' },
    { id: 'services', title: 'Services', desc: 'юниты, порты, логи, зависимости' },
    { id: 'automation', title: 'Automation', desc: 'постоянная конфигурация, netplan, повторяемость' }
  ];

  var LEVELS = [
    { id: 'beginner', title: 'Beginner', from: 0 },
    { id: 'junior', title: 'Junior', from: 20 },
    { id: 'middle', title: 'Middle', from: 40 },
    { id: 'advanced', title: 'Advanced', from: 62 },
    { id: 'expert', title: 'Expert', from: 82 }
  ];

  function byId(id) {
    for (var i = 0; i < SKILLS.length; i++) if (SKILLS[i].id === id) return SKILLS[i];
    return null;
  }

  function emptyStats() {
    return {
      solved: 0, attempts: 0, failed: 0, ewma: 0, hints: 0,
      maxDifficulty: 0, difficultySum: 0, weak: {}, lastAt: 0, history: []
    };
  }

  /*
   * mastery(stats) -> 0..100
   *   volume   — сколько задач реально решено по навыку
   *   quality  — доля успешных попыток (экспоненциальное сглаживание)
   *   depth    — максимальная взятая сложность
   *   autonomy — насколько редко нужны подсказки
   */
  function mastery(stats) {
    if (!stats || !stats.attempts) return 0;
    var volume = Math.min(1, stats.solved / 8);
    var quality = Math.max(0, Math.min(1, stats.ewma));
    var depth = Math.min(1, stats.maxDifficulty / 5);
    var hintsPer = stats.solved ? stats.hints / stats.solved : 3;
    var autonomy = Math.max(0, 1 - hintsPer / 3);
    var raw = 0.35 * volume + 0.30 * quality + 0.20 * depth + 0.15 * autonomy;
    return Math.round(raw * 100);
  }

  function levelOf(percent) {
    var level = LEVELS[0];
    for (var i = 0; i < LEVELS.length; i++) {
      if (percent >= LEVELS[i].from) level = LEVELS[i];
    }
    var idx = LEVELS.indexOf(level);
    var next = LEVELS[idx + 1] || null;
    return {
      id: level.id, title: level.title, index: idx,
      next: next ? next.title : null,
      toNext: next ? Math.max(0, next.from - percent) : 0
    };
  }

  /* Общий уровень: средневзвешенное по навыкам с учётом покрытия тем. */
  function overall(allStats) {
    var vals = SKILLS.map(function (s) {
      return mastery(allStats[s.id] || emptyStats());
    });
    var touched = vals.filter(function (v) { return v > 0; }).length;
    var avg = vals.reduce(function (a, b) { return a + b; }, 0) / SKILLS.length;
    var coverage = touched / SKILLS.length;
    /* без широкого охвата высокий уровень не выдаётся */
    var percent = Math.round(avg * (0.55 + 0.45 * coverage));
    return { percent: percent, level: levelOf(percent), coverage: coverage, touched: touched };
  }

  NET.skills = {
    list: SKILLS,
    levels: LEVELS,
    get: byId,
    emptyStats: emptyStats,
    mastery: mastery,
    levelOf: levelOf,
    overall: overall
  };
})(window.NET);
