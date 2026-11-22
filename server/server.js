#!/usr/bin/env node
/**
 * 3366战神三国 / 三国Q战 服务端
 * - 兼容客户端 AES-128-CBC + Base64 的 HTTP JSON 协议
 * - 账号注册 / 登录 / Token 鉴权
 * - 云存档（完整 RoleModel 状态）
 * - 角色创建（复用客户端创建角色流程）
 *
 * 运行: node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const querystring = require('querystring');
const { createPayService } = require('./pay');
const { createGameService, normalizeSave, mergeProgress } = require('./game');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const DATA_DIR = path.resolve(ROOT, CONFIG.dataDir || './data');
const SAVE_DIR = path.join(DATA_DIR, 'saves');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STARTER_FILE = path.resolve(ROOT, CONFIG.starterFile || './starter.json');

const KEY = Buffer.from(CONFIG.aesKey, 'utf8');
const IV = Buffer.from(CONFIG.aesIv, 'utf8');
const gbk = new TextDecoder('gbk');

fs.mkdirSync(SAVE_DIR, { recursive: true });

/* ----------------------------- AES 协议 ----------------------------- */

function aesDecrypt(b64) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
  const plain = Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()]);
  return gbk.decode(plain); // 客户端 requestCode = gbk
}

function aesEncrypt(text) {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  const enc = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
  return enc.toString('base64'); // 客户端 responseCode = utf-8
}

/* ----------------------------- 数据存储 ----------------------------- */

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    return { nextRoleID: 100000, users: {} };
  }
}

function saveUsers(db) {
  atomicWrite(USERS_FILE, JSON.stringify(db, null, 2));
}

function savePath(userID) {
  return path.join(SAVE_DIR, userID + '.json');
}

function readSave(userID) {
  try {
    return normalizeSave(JSON.parse(fs.readFileSync(savePath(userID), 'utf8')));
  } catch (e) {
    return null;
  }
}

function writeSave(userID, obj) {
  atomicWrite(savePath(userID), JSON.stringify(obj));
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function findUserByName(db, username) {
  return db.users[username] || null;
}

function findUserByToken(db, token) {
  if (!token) return null;
  for (const name of Object.keys(db.users)) {
    if (db.users[name].token && db.users[name].token === token) {
      return { username: name, user: db.users[name] };
    }
  }
  return null;
}

/* ----------------------------- 充值 / 支付 ----------------------------- */

const pay = createPayService({
  rootDir: ROOT,
  configFile: path.join(ROOT, 'pay-config.json'),
  dataDir: DATA_DIR,
  maxBodyBytes: 1024 * 1024,
  loadUsers,
  hashPassword,
  readSave,
  writeSave,
});

/**
 * 游戏逻辑（商店、副本、武将、擂台等）。
 * 客端的 shop.xml / staticgeneral.xml / stage.xml 在服务端上一级目录。
 */
const game = createGameService({
  rootDir: ROOT,
  dataDir: DATA_DIR,
});

/**
 * 把已支付但尚未领取的点卡写入存档，并把订单标记为已发放。
 * 在登录、创建角色、游戏内 head=10009 时调用。
 */
function applyPendingCredits(userID, save) {
  if (!save) return save;
  const orders = pay.pendingOrders(userID);
  if (!orders.length) return save;

  let add = 0;
  for (const o of orders) add += Math.max(0, Math.floor(Number(o.dianka) || 0));
  if (add > 0) {
    save.dianka = Math.max(0, Math.floor(Number(save.dianka) || 0)) + add;
    writeSave(userID, save); // 先落盘，成功后再标记订单已发放
  }
  pay.markCredited(orders.map((o) => o.orderNo));
  return save;
}

/* ----------------------------- 业务实现 ----------------------------- */

const OK = (data) => Object.assign({ success: true }, data || {});
const FAIL = (message) => ({ success: false, message: String(message || '操作失败') });

function validateAccount(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_一-龥]{3,20}$/.test(username)) {
    return '账号需为 3-20 位字母、数字、下划线或汉字';
  }
  if (typeof password !== 'string' || password.length < 4 || password.length > 32) {
    return '密码长度需为 4-32 位';
  }
  return null;
}

function handleRegister(req, db) {
  const username = String(req.username || '').trim();
  const password = String(req.password || '');
  const err = validateAccount(username, password);
  if (err) return FAIL(err);
  if (findUserByName(db, username)) return FAIL('该账号已被注册');

  const userID = 'u' + randomHex(6);
  const salt = randomHex(16);
  const token = randomHex(24);
  db.users[username] = {
    userID,
    salt,
    hash: hashPassword(password, salt),
    token,
    createdAt: Date.now(),
    lastLogin: Date.now(),
  };
  saveUsers(db);

  let save = null;
  const roleName = String(req.roleName || '').trim();
  if (roleName) {
    const created = createRoleInternal(db, username, db.users[username], roleName, req.imageID);
    if (created.error) return FAIL(created.error);
    save = applyPendingCredits(userID, created.save);
  }

  return OK({
    data: {
      token,
      userID,
      username,
      newPlayer: save == null,
      save,
    },
  });
}

function handleLogin(req, db) {
  const username = String(req.username || '').trim();
  const password = String(req.password || '');
  const user = findUserByName(db, username);
  if (!user) return FAIL('账号不存在');
  if (hashPassword(password, user.salt) !== user.hash) return FAIL('密码错误');

  const token = randomHex(24);
  user.token = token;
  user.lastLogin = Date.now();
  saveUsers(db);

  let save = readSave(user.userID);
  if (save) {
    save = applyPendingCredits(user.userID, save);
    save.token = token;
  }
  return OK({
    data: {
      token,
      userID: user.userID,
      username,
      newPlayer: save == null,
      save,
    },
  });
}

function handleLegacyLogin(req, db) {
  const token = String(req.token || '');
  const byToken = findUserByToken(db, token);
  if (byToken) {
    let save = readSave(byToken.user.userID);
    if (save) {
      save = applyPendingCredits(byToken.user.userID, save);
      save.token = token;
    }
    return OK({
      data: { token, userID: byToken.user.userID, username: byToken.username, newPlayer: save == null, save },
    });
  }
  // 兼容用 userID + password 登录
  const userID = String(req.userID || '');
  const password = String(req.password || '');
  for (const name of Object.keys(db.users)) {
    const u = db.users[name];
    if (u.userID === userID && password && hashPassword(password, u.salt) === u.hash) {
      const newToken = randomHex(24);
      u.token = newToken;
      saveUsers(db);
      let save = readSave(u.userID);
      if (save) {
        save = applyPendingCredits(u.userID, save);
        save.token = newToken;
      }
      return OK({ data: { token: newToken, userID: u.userID, username: name, newPlayer: save == null, save } });
    }
  }
  return FAIL('登录信息无效，请重新登录');
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function createRoleInternal(db, username, user, roleName, imageID) {
  const name = String(roleName || '').trim();
  if (!name || name.length > 12) return { error: '角色名需为 1-12 个字符' };
  let starter;
  try {
    starter = JSON.parse(fs.readFileSync(STARTER_FILE, 'utf8'));
  } catch (e) {
    return { error: '服务器缺少 starter.json 初始角色模板' };
  }
  const save = deepClone(starter);
  // 每个新角色重新生成武将实例 ID，避免所有玩家共用 starter.json 里的同一套 ID
  if (Array.isArray(save.armyModel)) {
    const usedIds = new Set();
    for (const g of save.armyModel) {
      if (!g || typeof g !== 'object') continue;
      let gid;
      do { gid = Math.floor(Math.random() * 9000000) + 1000000; } while (usedIds.has(gid));
      usedIds.add(gid);
      g.id = gid;
    }
  }
  save.token = user.token;
  save.roleModel = save.roleModel || {};
  save.roleModel.roleID = db.nextRoleID++;
  save.roleModel.userID = user.userID;
  save.roleModel.userName = username;
  save.roleModel.roleName = name;
  save.roleModel.imageID = [1, 2].includes(Number(imageID)) ? Number(imageID) : 1;
  save.taskStates = {};
  save.lastTaskResetDate = '';
  save.lastLoginRewardDate = '';
  delete save.guild;
  normalizeSave(save);
  writeSave(user.userID, save);
  saveUsers(db);
  return { save };
}

function handleCreateRole(req, db) {
  const token = String(req.token || '');
  const found = findUserByToken(db, token);
  if (!found) return FAIL('登录已过期，请重新登录');

  // 幂等处理：角色已存在时直接返回已有存档。
  // 避免客户端重复点击“确认”/按钮双击导致第二次请求报“该账号已有角色”。
  let existing = readSave(found.user.userID);
  if (existing) {
    existing = applyPendingCredits(found.user.userID, existing);
    existing.token = token;
    return OK({ data: existing });
  }

  const created = createRoleInternal(db, found.username, found.user, req.roleName, req.imageID);
  if (created.error) return FAIL(created.error);
  const save = applyPendingCredits(found.user.userID, created.save);
  save.token = token;
  return OK({ data: save });
}

function handleSave(req, db) {
  const token = String(req.token || '');
  const found = findUserByToken(db, token);
  if (!found) return FAIL('登录已过期，请重新登录');

  const data = req.data;
  if (!data || typeof data !== 'object' || !data.roleModel) {
    return FAIL('存档数据无效');
  }
  // 未创建角色前不允许写入空存档
  let existing = readSave(found.user.userID);
  if (!existing) return FAIL('尚未创建角色');

  // 自动存档前先把“已支付但未领取”的点卡结算掉，避免玩家的 15 秒自动存档抢先覆盖。
  existing = applyPendingCredits(found.user.userID, existing);

  // 点卡是服务端货币：客户端上传的 dianka 一律忽略。
  // 否则旧客户端 / 离线存档里的旧余额会把刚充值的点卡（或服务端扣费）覆盖掉。
  data.dianka = Math.max(0, Math.floor(Number(existing.dianka) || 0));

  // 迁移旧存档：把混进 finished 的大地图 id 挪到 bigMapFinished，修正 history 的 0。
  // 并与服务端已有进度做并集，防止战斗前的旧自动存档覆盖战斗结算进度。
  normalizeSave(data);
  const clientFinished = String((data.process && data.process.finished) || '');
  mergeProgress(existing, data);
  if (clientFinished !== String((data.process && data.process.finished) || '')) {
    console.log('[save] ' + found.username + ' 进度合并: 客户端=' + clientFinished +
      ' 合并后=' + data.process.finished);
  }

  data.token = token;
  data.savedAt = Date.now();
  writeSave(found.user.userID, data);
  return OK({ data: { savedAt: data.savedAt } });
}

/**
 * head=10009：游戏内领取点卡（充值完成后点击商城 / 关闭剧情时触发）。
 * 把支付成功但未领取的点卡写入存档，并返回最新余额。
 */
function handleNewDianka(req, db) {
  const token = String(req.token || '');
  const found = findUserByToken(db, token);
  if (!found) return FAIL('登录已过期，请重新登录');

  let save = readSave(found.user.userID);
  if (!save) return OK({ data: { dianka: 0 } });
  save = applyPendingCredits(found.user.userID, save);
  return OK({ data: { dianka: Math.max(0, Math.floor(Number(save.dianka) || 0)) } });
}

/**
 * 其余 HTTP_NEW_* 请求：用 token 定位玩家，交给 game.js 处理并写回存档。
 */
function handleGameRequest(req, db) {
  const found = findUserByToken(db, String(req.token || ''));
  if (!found) return FAIL('登录已过期，请重新登录');

  const save = readSave(found.user.userID);
  if (!save) return FAIL('尚未创建角色');

  const reqRoleID = req.roleID;
  if (reqRoleID != null && String(reqRoleID) !== '' &&
      String(reqRoleID) !== String((save.roleModel && save.roleModel.roleID) || '')) {
    return FAIL('角色信息不匹配，请重新登录');
  }

  const result = game.handle(req, save, found.user.userID, {
    applyPendingCredits: (userID, obj) => applyPendingCredits(userID, obj),
  });
  writeSave(found.user.userID, save);
  return result;
}

function handleRequest(req) {
  const db = loadUsers();
  const head = Number(req.head);
  switch (head) {
    case 9001:
    case 9999:
      return head === 9001 ? handleLogin(req, db) : handleLegacyLogin(req, db);
    case 9002:
      return handleRegister(req, db);
    case 9003:
      return handleSave(req, db);
    case 10000:
      return handleCreateRole(req, db);
    case 10009:
      return handleNewDianka(req, db);
    default:
      return handleGameRequest(req, db);
  }
}

/* ----------------------------- HTTP 服务 ----------------------------- */

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  }, headers || {}));
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, JSON.stringify({ ok: true, time: Date.now() }), { 'Content-Type': 'application/json; charset=utf-8' });
  }
  if (req.method === 'GET' && url.pathname === '/crossdomain.xml') {
    return send(res, 200,
      '<?xml version="1.0"?><!DOCTYPE cross-domain-policy SYSTEM "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">' +
      '<cross-domain-policy><allow-access-from domain="*" to-ports="*"/></cross-domain-policy>',
      { 'Content-Type': 'text/x-cross-domain-policy' });
  }

  if (url.pathname === '/pay' || url.pathname.startsWith('/pay/')) {
    pay.handle(req, res, url).catch((e) => {
      console.error('[pay]', e);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: '支付服务内部错误' }));
      }
    });
    return;
  }

  if (req.method !== 'POST' || (url.pathname !== '/' && url.pathname !== '/api')) {
    return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > (CONFIG.maxBodyBytes || 10 * 1024 * 1024)) {
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const contentType = req.headers['content-type'] || '';
    const plain = url.searchParams.get('plain') === '1' || contentType.includes('application/json');
    let payload;
    try {
      if (plain) {
        payload = JSON.parse(raw);
      } else {
        const form = querystring.parse(raw);
        if (!form.data) throw new Error('缺少 data 字段');
        payload = JSON.parse(aesDecrypt(String(form.data)));
      }
    } catch (e) {
      return send(res, 400, JSON.stringify({ success: false, message: '请求解析失败: ' + e.message }),
        { 'Content-Type': 'application/json; charset=utf-8' });
    }

    let result;
    try {
      result = handleRequest(payload);
    } catch (e) {
      console.error('[handler]', e);
      result = FAIL('服务器内部错误');
    }
    result.stamp = payload.stamp;
    const text = JSON.stringify(result);

    if (plain) {
      return send(res, 200, text, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    return send(res, 200, aesEncrypt(text), { 'Content-Type': 'text/plain; charset=utf-8' });
  });
});

const port = Number(process.env.PORT || CONFIG.port || 8080);
const host = process.env.HOST || CONFIG.host || '0.0.0.0';
server.listen(port, host, () => {
  console.log(`[sanguo-server] listening on http://${host}:${port}`);
  console.log(`[sanguo-server] 充值网站: http://${host}:${port}/pay`);
  console.log(`[sanguo-server] data dir: ${DATA_DIR}`);
});
