/*
 * debrief.js — сборка разбора после задачи.
 * Разбор всегда отвечает на четыре вопроса: что было сломано, почему появились
 * именно эти симптомы, какие команды были нужны и что вы упустили.
 */
(function (NET) {
  'use strict';

  function build(report) {
    var lab = NET.labs.get(report.labId);
    var d = report.debrief || {};
    var steps = report.steps || { missed: [], done: 0, total: 0 };

    /* Команды пользователя, сгруппированные по «полезности» */
    var useful = [], noise = [];
    var usefulRe = /^(ip|ping|ping6|traceroute|tracepath|mtr|ss|netstat|dig|host|nslookup|resolvectl|tcpdump|curl|wget|nc|telnet|systemctl|journalctl|ufw|iptables|nft|netplan|nmcli|dhclient|ethtool|arping|arp|route|ifconfig|sshd|nginx|cat|grep|less|sysctl)\b/;
    (report.commands || []).forEach(function (c) {
      var line = c.line.replace(/^sudo\s+/, '');
      (usefulRe.test(line) ? useful : noise).push(c.line);
    });

    return {
      labId: report.labId,
      title: report.title,
      variant: report.variantId,
      score: report.score,
      grade: report.grade,
      duration: report.duration,
      hints: report.hints,
      attempts: report.attempts,
      mode: report.mode,
      coveragePercent: Math.round((report.coverage || 0) * 100),
      why: d.why || (lab && lab.debrief && lab.debrief.why) || '',
      commands: d.commands || [],
      pitfalls: d.pitfalls || [],
      theory: d.theory ? NET.theory.get(d.theory) : null,
      missedSteps: steps.missed.map(function (s) { return s.title; }),
      doneSteps: steps.done,
      totalSteps: steps.total,
      userCommands: useful,
      noiseCommands: noise,
      skills: (report.skills || []).map(function (id) {
        var s = NET.skills.get(id);
        return s ? s.title : id;
      }),
      nextVariant: suggestNext(report)
    };
  }

  /* Похожая задача для закрепления: другой вариант той же лабораторной. */
  function suggestNext(report) {
    var lab = NET.labs.get(report.labId);
    if (!lab) return null;
    var variants = NET.labs.variants(lab);
    var seen = NET.progress.solvedVariants(report.labId);
    var unseen = variants.filter(function (v) { return seen.indexOf(v.id) < 0; });
    if (unseen.length) {
      return {
        kind: 'variant', labId: lab.id,
        index: variants.indexOf(unseen[0]),
        title: 'Похожая задача: ' + lab.title + ' (' + unseen[0].name + ')'
      };
    }
    /* все варианты пройдены — предлагаем следующую по сложности лабораторию */
    var harder = NET.labs.list().filter(function (l) {
      return !NET.progress.isLabSolved(l.id) && l.difficulty >= lab.difficulty;
    });
    if (harder.length) {
      return { kind: 'lab', labId: harder[0].id, title: 'Следующая: ' + harder[0].title };
    }
    var weak = NET.progress.weakSkills(1)[0];
    if (weak) {
      return { kind: 'quick', skill: weak.id, title: 'Короткая практика по слабой теме: ' + weak.title };
    }
    return null;
  }

  NET.debrief = { build: build, suggestNext: suggestNext };
})(window.NET);
