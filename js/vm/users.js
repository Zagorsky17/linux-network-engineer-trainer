/*
 * users.js — пользователи, группы, sudo.
 * Модель питает /etc/passwd, /etc/group, /etc/shadow и проверки прав в VFS.
 */
(function (NET) {
  'use strict';

  function UserDB() {
    this.users = [];
    this.groups = [];
    this.nextUid = 1001;
    this.nextGid = 1001;
  }

  UserDB.prototype.addGroup = function (name, gid, members) {
    var g = { name: name, gid: gid === undefined ? this.nextGid++ : gid, members: members || [] };
    if (g.gid >= this.nextGid) this.nextGid = g.gid + 1;
    this.groups.push(g);
    return g;
  };

  UserDB.prototype.addUser = function (spec) {
    var uid = spec.uid === undefined ? this.nextUid++ : spec.uid;
    if (uid >= this.nextUid) this.nextUid = uid + 1;
    var primary = this.groupByName(spec.group || spec.name) || this.addGroup(spec.group || spec.name, spec.gid);
    var u = {
      name: spec.name,
      uid: uid,
      gid: primary.gid,
      gecos: spec.gecos || '',
      home: spec.home || ('/home/' + spec.name),
      shell: spec.shell || '/bin/bash',
      password: spec.password === undefined ? '$6$rounds=656000$' + spec.name : spec.password,
      system: !!spec.system
    };
    this.users.push(u);
    (spec.extraGroups || []).forEach(function (gn) {
      var g = this.groupByName(gn) || this.addGroup(gn);
      if (g.members.indexOf(u.name) < 0) g.members.push(u.name);
    }, this);
    return u;
  };

  UserDB.prototype.byName = function (name) {
    for (var i = 0; i < this.users.length; i++) if (this.users[i].name === name) return this.users[i];
    return null;
  };

  UserDB.prototype.byUid = function (uid) {
    for (var i = 0; i < this.users.length; i++) if (this.users[i].uid === uid) return this.users[i];
    return null;
  };

  UserDB.prototype.groupByName = function (name) {
    for (var i = 0; i < this.groups.length; i++) if (this.groups[i].name === name) return this.groups[i];
    return null;
  };

  UserDB.prototype.groupByGid = function (gid) {
    for (var i = 0; i < this.groups.length; i++) if (this.groups[i].gid === gid) return this.groups[i];
    return null;
  };

  UserDB.prototype.groupsOf = function (name) {
    var u = this.byName(name);
    if (!u) return [];
    var out = [u.gid];
    this.groups.forEach(function (g) {
      if (g.members.indexOf(name) >= 0 && out.indexOf(g.gid) < 0) out.push(g.gid);
    });
    return out;
  };

  UserDB.prototype.groupNamesOf = function (name) {
    var self = this;
    return this.groupsOf(name).map(function (gid) {
      var g = self.groupByGid(gid);
      return g ? g.name : String(gid);
    });
  };

  /* Контекст прав для VFS и команд. */
  UserDB.prototype.ctx = function (name) {
    var u = this.byName(name);
    if (!u) return { uid: 65534, gid: 65534, groups: [65534], user: 'nobody' };
    return { uid: u.uid, gid: u.gid, groups: this.groupsOf(name), user: u.name, home: u.home };
  };

  UserDB.prototype.canSudo = function (name) {
    if (name === 'root') return true;
    return this.groupNamesOf(name).indexOf('sudo') >= 0;
  };

  /* ---------- файлы ---------- */

  UserDB.prototype.passwdFile = function () {
    return this.users.map(function (u) {
      return [u.name, 'x', u.uid, u.gid, u.gecos, u.home, u.shell].join(':');
    }).join('\n') + '\n';
  };

  UserDB.prototype.groupFile = function () {
    return this.groups.map(function (g) {
      return [g.name, 'x', g.gid, g.members.join(',')].join(':');
    }).join('\n') + '\n';
  };

  UserDB.prototype.shadowFile = function () {
    return this.users.map(function (u) {
      return [u.name, u.password || '*', '19900', '0', '99999', '7', '', '', ''].join(':');
    }).join('\n') + '\n';
  };

  /* Базовый набор Ubuntu. */
  UserDB.ubuntu = function (mainUser) {
    var db = new UserDB();
    db.addGroup('root', 0);
    db.addGroup('daemon', 1);
    db.addGroup('adm', 4);
    db.addGroup('tty', 5);
    db.addGroup('sudo', 27);
    db.addGroup('netdev', 118);
    db.addGroup('systemd-journal', 101);
    db.addGroup('nogroup', 65534);
    db.addUser({ name: 'root', uid: 0, group: 'root', home: '/root', system: true });
    db.addUser({ name: 'daemon', uid: 1, group: 'daemon', home: '/usr/sbin', shell: '/usr/sbin/nologin', system: true });
    db.addUser({ name: 'systemd-network', uid: 998, group: 'systemd-network', shell: '/usr/sbin/nologin', home: '/run/systemd', system: true });
    db.addUser({ name: 'sshd', uid: 104, group: 'nogroup', gid: 65534, shell: '/usr/sbin/nologin', home: '/run/sshd', system: true });
    db.addUser({ name: 'www-data', uid: 33, group: 'www-data', shell: '/usr/sbin/nologin', home: '/var/www', system: true });
    db.addUser({
      name: mainUser || 'user', uid: 1000, group: mainUser || 'user',
      gecos: 'Network Engineer', extraGroups: ['sudo', 'adm', 'netdev']
    });
    db.addUser({ name: 'nobody', uid: 65534, group: 'nogroup', gid: 65534, shell: '/usr/sbin/nologin', home: '/nonexistent', system: true });
    return db;
  };

  NET.UserDB = UserDB;
})(window.NET);
