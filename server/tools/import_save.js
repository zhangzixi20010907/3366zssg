#!/usr/bin/env node
/**
 * 把本地离线存档（data.json）导入到某个服务端账号。
 *
 * 用法：
 *   node tools/import_save.js --user 账号 --file ..\data.json
 *   node tools/import_save.js --user 账号 --file ..\data.json --data-dir ./data
 *
 * 说明：
 *   - 账号必须已经注册（users.json 里存在）。
 *   - 会覆盖该账号现有的服务端存档，请先备份 data/saves/。
 *   - 存档里的 roleID 如果为空 / 与其他角色冲突，会自动分配新 roleID。
 */
'use strict';

const fs = require('fs');
const path = require('path');

function usage(code) {
  console.log('用法: node tools/import_save.js --user <账号> --file <data.json> [--data-dir ./data]');
  process.exit(code || 0);
}

const args = process.argv.slice(2);
let username = '';
let file = '';
let dataDir = path.resolve(__dirname, '..', 'data');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--user') username = args[++i];
  else if (args[i] === '--file') file = args[++i];
  else if (args[i] === '--data-dir') dataDir = path.resolve(args[++i]);
  else if (args[i] === '-h' || args[i] === '--help') usage(0);
  else { console.error('未知参数: ' + args[i]); usage(1); }
}
if (!username || !file) usage(1);

const usersFile = path.join(dataDir, 'users.json');
const saveDir = path.join(dataDir, 'saves');
if (!fs.existsSync(usersFile)) {
  console.error('找不到 ' + usersFile + '，请先在服务端目录运行。');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
if (!db.users || !db.users[username]) {
  console.error('账号不存在: ' + username + '（请先在游戏里注册）');
  process.exit(1);
}
if (db.nextRoleID == null) db.nextRoleID = 100000;

const user = db.users[username];
let save;
try {
  save = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
} catch (e) {
  console.error('读取存档失败: ' + e.message);
  process.exit(1);
}
if (!save || typeof save !== 'object' || !save.roleModel) {
  console.error('存档格式不正确：缺少 roleModel');
  process.exit(1);
}

// 离线存档的 roleID 通常很小（如 13），统一换成服务端新分配的 ID，避免与其他玩家冲突
if (!save.roleModel.roleID || save.roleModel.roleID < 100000) {
  save.roleModel.roleID = db.nextRoleID++;
}
save.roleModel.userID = user.userID;
save.roleModel.userName = username;
if (!save.roleModel.roleName) save.roleModel.roleName = username;
if (save.dianka == null) save.dianka = 0;

fs.mkdirSync(saveDir, { recursive: true });
fs.writeFileSync(path.join(saveDir, user.userID + '.json'), JSON.stringify(save));
fs.writeFileSync(usersFile, JSON.stringify(db, null, 2));

console.log('已导入存档:');
console.log('  账号   : ' + username + ' (' + user.userID + ')');
console.log('  角色   : ' + save.roleModel.roleName + '  Lv.' + save.roleModel.level + '  roleID=' + save.roleModel.roleID);
console.log('  点卡   : ' + save.dianka);
console.log('  文件   : ' + path.join(saveDir, user.userID + '.json'));
