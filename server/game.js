#!/usr/bin/env node
/**
 * 战神三国 / 三国Q战 —— 服务端游戏逻辑
 *
 * 客户端把 AESController.test 关闭后，所有 HTTP_NEW_* 请求都会发到本服务端。
 * 本模块按客户端 Test.as 的原有规则实现这些 head，并把状态写回玩家存档。
 *
 * 设计：
 *   - 存档仍由 server.js 读写；本模块只修改传入的 save 对象。
 *   - 副本次数、一次性领取标记等“客户端不保存”的数据放在 data/meta.json。
 *   - 竞技擂台名单放内存（重启后恢复初始状态）。
 *
 * 不依赖任何第三方 npm 包。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ----------------------------- 小工具 ----------------------------- */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : 0;
};
const clamp0 = (n) => Math.max(0, num(n));
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// 副本次数的“一天”从早上 6 点开始：06:00 之前仍算前一天，06:00 重置。
function dateKey(d) {
  const dt = new Date((d || new Date()).getTime());
  dt.setHours(dt.getHours() - 6);
  return dt.getFullYear() + '-' + (dt.getMonth() + 1) + '-' + dt.getDate();
}

// 每日副本次数（客户端四个副本面板都显示 6 次）
const DAILY_FUBEN_COUNT = 6;
// meta.fuben 结构版本；升级默认次数时改这个值可让老存档一次性按新规则重置
const FUBEN_META_VERSION = 2;

/* ----------------------------- 配置数据 ----------------------------- */

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (e) {
    return '';
  }
}

/** 极简 <RECORD> 解析：返回每个 RECORD 的字段 map */
function parseRecords(xml) {
  const out = [];
  const records = String(xml).match(/<RECORD>[\s\S]*?<\/RECORD>/g) || [];
  for (const rec of records) {
    const obj = {};
    // 去掉外层 RECORD 标签，否则字段正则会先匹配到外层标签
    const inner = rec.slice('<RECORD>'.length, rec.length - '</RECORD>'.length);
    const re = /<([A-Za-z0-9_]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let m;
    while ((m = re.exec(inner))) obj[m[1]] = m[2].trim();
    out.push(obj);
  }
  return out;
}

function loadShop(file) {
  const map = {};
  for (const r of parseRecords(readText(file))) {
    if (!r.id) continue;
    map[r.id] = {
      id: r.id,
      name: r.name || '',
      code: r.code || '',
      count: num(r.count) || 1,
      payType: num(r.payType),
      price: num(r.newPrice),
    };
  }
  return map;
}

function loadGenerals(file) {
  const map = {};
  for (const r of parseRecords(readText(file))) {
    if (!r.code) continue;
    map[r.code] = {
      code: r.code,
      name: r.name || '',
      type: num(r.type),
      title: num(r.title),
      kezhi: r.kezhi || '',
      jinbi: num(r.jinbi),
      coint: num(r.coint),
      proto: r.proto || '',
      skin: r.skin || '',
    };
  }
  return map;
}

function loadStages(file) {
  const byKey = {};
  const byId = {};
  const xml = readText(file);
  const gates = xml.match(/<gate\b[\s\S]*?<\/gate>/g) || [];
  for (const g of gates) {
    const head = g.match(/<gate\b([^>]*)>/);
    if (!head) continue;
    const attrs = {};
    const re = /([A-Za-z0-9_]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(head[1]))) attrs[m[1]] = m[2];
    const awardTag = g.match(/<award\b([^>]*)\/?>/);
    const award = {};
    if (awardTag) {
      const ar = /([A-Za-z0-9_]+)="([^"]*)"/g;
      let am;
      while ((am = ar.exec(awardTag[1]))) award[am[1]] = am[2];
    }
    const info = {
      id: num(attrs.id),
      part: num(attrs.part),
      level: num(attrs.level),
      name: attrs.name || '',
      partName: attrs.partName || '',
      award: {
        money: num(award.money),
        reverence: num(award.reverence),
        exploit: num(award.exploit),
        soldier: award.soldier || '',
        recruit: award.recruit || '',
        proto: award.proto || '',
      },
    };
    byKey[info.part + '_' + info.level] = info;
    byId[info.id] = info;
  }
  return { byKey, byId };
}

/* ----------------------------- 逻辑公式 ----------------------------- */

const JINHUA_RATE = [1, 0.7, 0.3, 0.15, 0.05, 0.08, 0.08, 0.05, 0.03, 0.01, 0.01];
const KEZHI_RATE = [1, 0.8, 0.6, 0.3, 0.15, 0.1, 0.08, 0.05, 0.03, 0.02, 0.01];

function jinhuaRate(evo) { return JINHUA_RATE[Math.min(10, Math.max(0, num(evo)))]; }
function kezhiRate(level) { return KEZHI_RATE[Math.min(10, Math.max(0, num(level)))]; }

function moneyByFight(m, n) { const d = num(m) - num(n); return d < 0 ? 200 : 600 + d * 10; }
function exploitByFight(m, n) { const d = num(m) - num(n); return d < 0 ? 50 : 100 + d * 10; }
function reverenceByFight(m, n) { const d = num(m) - num(n); return d < 0 ? 10 : 50 + d * 2; }

function kezhiLevels(str) {
  const parts = String(str || '').split('|');
  const out = [];
  for (let i = 0; i < 3; i++) {
    const seg = (parts[i] || '').split(':');
    out.push({ type: num(seg[0]), level: seg.length > 1 ? num(seg[1]) : 0 });
  }
  return out;
}
function kezhiString(levels) {
  return levels.map((x) => x.type + ':' + Math.max(0, num(x.level))).join('|');
}

/* ----------------------------- 存档辅助 ----------------------------- */

function rm(save) { return save.roleModel || (save.roleModel = {}); }
function bag(save) { return Array.isArray(save.bagModel) ? save.bagModel : (save.bagModel = []); }
function army(save) { return Array.isArray(save.armyModel) ? save.armyModel : (save.armyModel = []); }

function bagFind(save, code) { return bag(save).find((b) => b && b.code === code) || null; }
function bagCount(save, code) { const b = bagFind(save, code); return b ? clamp0(b.count) : 0; }
function bagSet(save, code, total, newId) {
  const b = bagFind(save, code);
  if (total <= 0) {
    if (b) { const i = bag(save).indexOf(b); bag(save).splice(i, 1); }
    return null;
  }
  if (b) { b.count = String(Math.min(99, total)); return b; }
  const item = { id: newId || randInt(1, 9999999), code, count: String(Math.min(99, total)) };
  bag(save).push(item);
  return item;
}
function bagAdd(save, code, n) { return bagSet(save, code, bagCount(save, code) + num(n)); }
function bagById(save, id) { return bag(save).find((b) => b && Number(b.id) === Number(id)) || null; }

function armyFind(save, id) { return army(save).find((g) => g && Number(g.id) === Number(id)) || null; }
function addGeneral(save, g) { army(save).push(g); return g; }

function newGeneral(save, code, level, evolution, feature, genius, kezhi, generalData) {
  const info = generalData[code] || {};
  return {
    id: randInt(100000, 9999999),
    code,
    level: num(level) || 1,
    evolution: num(evolution) || 0,
    feature: num(feature) || 0,
    genius: genius || null,
    kezhi: kezhi || info.kezhi || '',
    skillUnlocked: false,
    skillLevel: 1,
    rentExpire: 0,
    equips: null,
  };
}

/**
 * 大地图（part=11）进度和主线进度必须分开存：
 *   - process.finished      只放主线关卡 id（1~100）
 *   - process.bigMapFinished 只放大地图关卡 level（1~9）
 * 旧版本把大地图 gate id（101~109）和 1101~1109 混进了 finished，
 * 会让主线“上一关”判断失效、可以跳关，这里统一迁移。
 */
const BIGMAP_PART = 11;
const BIGMAP_LEVELS = 9;
const BIGMAP_FIRST_GATE_ID = 101;

/**
 * 乌林遗迹（part=12）副本：
 *   - 10 个关卡，gate id 201~210
 *   - 进度直接写 process.finished（id > 100，不影响主线 maxNormalFinished 判断）
 *   - 必须按顺序通关，且不提升君主等级
 */
const WULIN_PART = 12;
const WULIN_LEVELS = 10;
const WULIN_FIRST_GATE_ID = 201;

function idList(v) {
  return String(v == null ? '' : v)
    .split('|')
    .map(num)
    .filter((x) => x > 0);
}

function normalizeSave(save) {
  if (!save || typeof save !== 'object') return save;
  if (!save.process || typeof save.process !== 'object') save.process = {};
  const p = save.process;

  // 迁移旧版误存进 finished 的大地图 id
  const finished = [];
  const big = idList(p.bigMapFinished);
  const bigSet = new Set(big);
  for (const id of idList(p.finished)) {
    if (id >= BIGMAP_FIRST_GATE_ID && id <= BIGMAP_FIRST_GATE_ID + BIGMAP_LEVELS - 1) {
      bigSet.add(id - BIGMAP_FIRST_GATE_ID + 1);
    } else if (id >= 1101 && id <= 1100 + BIGMAP_LEVELS) {
      bigSet.add(id - 1100);
    } else if (finished.indexOf(id) === -1) {
      finished.push(id);
    }
  }
  finished.sort((a, b) => a - b);
  const bigArr = Array.from(bigSet).filter((lv) => lv >= 1 && lv <= BIGMAP_LEVELS).sort((a, b) => a - b);

  const finishedStr = finished.join('|');
  const bigStr = bigArr.join('|');
  if (String(p.finished == null ? '' : p.finished) !== finishedStr) p.finished = finishedStr;
  if (String(p.bigMapFinished == null ? '' : p.bigMapFinished) !== bigStr) p.bigMapFinished = bigStr;

  // history 是 10 个剧情章节的状态：1 未解锁 / 2 已解锁 / 3 已进入 / 4 已通关。
  // 旧 starter 是全 0，客户端 checkPart 只把 1 当作锁定，0 会变成“可点击”。
  const oldHistory = String(p.history == null ? '' : p.history).split('|').map(num);
  const history = [];
  for (let i = 0; i < 10; i++) {
    let v = oldHistory[i];
    if (v == null || v < 1 || v > 4) v = i === 0 ? 2 : 1;
    history.push(v);
  }
  const historyStr = history.join('|');
  if (String(p.history == null ? '' : p.history) !== historyStr) p.history = historyStr;

  return save;
}

/** 主线已通关的最大关卡 id（忽略大地图/脏数据） */
function maxNormalFinished(save) {
  let max = 0;
  for (const id of idList(save && save.process && save.process.finished)) {
    if (id <= 100 && id > max) max = id;
  }
  return max;
}

/**
 * 客户端 9003 存档是整包上传的：如果一次旧自动存档（战斗前生成）在
 * 战斗结算 10011 之后才到达，会把这个刚写入的关卡进度覆盖掉。
 * 因此服务端对“进度类”字段只做并集/取大，绝不让 9003 回退。
 */
function mergeProgress(existing, data) {
  if (!existing || !data) return data;
  normalizeSave(existing);
  normalizeSave(data);
  const ep = existing.process;
  const dp = data.process;

  const fin = new Set(idList(ep.finished));
  for (const id of idList(dp.finished)) fin.add(id);
  const big = new Set(idList(ep.bigMapFinished));
  for (const lv of idList(dp.bigMapFinished)) big.add(lv);

  const oldH = String(ep.history || '').split('|').map(num);
  const newH = String(dp.history || '').split('|').map(num);
  const hist = [];
  for (let i = 0; i < 10; i++) {
    const a = oldH[i] == null ? 0 : oldH[i];
    const b = newH[i] == null ? 0 : newH[i];
    hist.push(Math.max(a, b));
  }

  dp.finished = Array.from(fin).sort((a, b) => a - b).join('|');
  dp.bigMapFinished = Array.from(big)
    .filter((lv) => lv >= 1 && lv <= BIGMAP_LEVELS)
    .sort((a, b) => a - b)
    .join('|');
  dp.history = hist.join('|');

  // 君主等级同样只增不减
  if (data.roleModel && existing.roleModel) {
    const oldLv = num(existing.roleModel.level);
    const newLv = num(data.roleModel.level);
    if (oldLv > newLv) data.roleModel.level = oldLv;
  }
  return data;
}

/* ----------------------------- 服务端游戏逻辑 ----------------------------- */

function createGameService(opts) {
  const rootDir = opts.rootDir;
  const dataDir = opts.dataDir;
  const metaFile = path.join(dataDir, 'meta.json');

  // 本地开发时 XML 在 server 的上一级；部署到 /opt/sanguo 时可以直接放在同目录或 data-files/
  const dataDirs = [
    path.resolve(rootDir),
    path.resolve(rootDir, 'data-files'),
    path.resolve(rootDir, '..'),
    path.resolve(rootDir, '..', 'data-files'),
  ];
  function dataFile(name) {
    for (const d of dataDirs) {
      const f = path.join(d, name);
      if (fs.existsSync(f)) return f;
    }
    console.warn('[game] 找不到数据文件 ' + name + '，尝试过的目录: ' + dataDirs.join(', '));
    return path.join(rootDir, name);
  }

  const shop = loadShop(dataFile('shop.xml'));
  const generals = loadGenerals(dataFile('staticgeneral.xml'));
  const stages = loadStages(dataFile('stage.xml'));
  if (!Object.keys(shop).length) console.warn('[game] shop.xml 未解析到商品，商城购买将不可用');
  if (!Object.keys(generals).length) console.warn('[game] staticgeneral.xml 未解析到武将，招募将不可用');

  let meta = loadMeta();
  function loadMeta() {
    try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {}; } catch (e) { return {}; }
  }
  function saveMeta() { atomicWrite(metaFile, JSON.stringify(meta)); }
  function userMeta(userID) {
    if (!meta[userID] || typeof meta[userID] !== 'object') meta[userID] = {};
    return meta[userID];
  }
  function dailyFuben(userID, stageID) {
    const m = userMeta(userID);
    const today = dateKey();
    // date 变化（每天 06:00）或结构版本变化时重置全部副本次数
    if (!m.fuben || m.fuben.date !== today || m.fuben.version !== FUBEN_META_VERSION) {
      m.fuben = { date: today, counts: {}, version: FUBEN_META_VERSION };
    }
    const key = String(num(stageID));
    if (m.fuben.counts[key] == null) m.fuben.counts[key] = DAILY_FUBEN_COUNT;
    return m.fuben.counts;
  }

  // 擂台：进程内静态名单（与客户端 Test 结构一致，便于界面显示）
  function buildLeitai() {
    const list = [];
    const levels = [200, 180, 160, 140, 120, 90, 60, 30];
    let rid = 1;
    for (const lv of levels) {
      const prices = [
        { type: 1, price: 10000 },
        { type: 2, price: 10000 },
        { type: 3, price: 30 },
        { type: 1, price: 5000 },
        { type: 2, price: 5000 },
        { type: 3, price: 10 },
      ];
      for (const p of prices) {
        list.push({
          rID: rid++,
          rLevel: lv,
          rStatus: 0,
          rType: p.type,
          rPrice: p.price,
          rValue: 0,
          rCount: 0,
        });
      }
    }
    return list;
  }
  const leitaiData = buildLeitai();
  const paihang = Array.from({ length: 10 }, (_, i) => ({ roleName: '高手第' + (i + 1), score: 23456 }));

  function leitaiByRID(rid) { return leitaiData.find((r) => r.rID === Number(rid)) || null; }

  /* ---------- 单个请求处理 ---------- */

  function handle(req, save, userID, helpers) {
    normalizeSave(save);
    const head = Number(req.head);
    const role = rm(save);
    const now = Date.now();
    const dirty = { value: false };

    const ok = (data) => Object.assign({ success: true }, data === undefined ? {} : { data });
    const fail = (message) => ({ success: false, message: String(message || '操作失败') });
    const touch = () => { dirty.value = true; };

    // 擂台初始荣誉值
    if (head >= 10030 && head <= 10039 && role.rongyu == null) {
      role.rongyu = 100045;
      touch();
    }

    const setMoney = (v) => { role.money = clamp0(v); touch(); return role.money; };
    const setExploit = (v) => { role.exploit = clamp0(v); touch(); return role.exploit; };
    const setReverence = (v) => { role.reverence = clamp0(v); touch(); return role.reverence; };
    const setDianka = (v) => { save.dianka = clamp0(v); touch(); return save.dianka; };

    switch (head) {
      /* ===== 登录 / 存档 / 充值相关 ===== */
      case 10009: { // 领取点卡
        const credited = helpers.applyPendingCredits(userID, save);
        return ok({ dianka: clamp0(credited.dianka) });
      }

      /* ===== 武将 ===== */
      case 10004: { // 武将升级
        const g = armyFind(save, req.id);
        if (!g) return fail('武将不存在');
        if (num(g.level) >= 220) return fail('武将已经顶级，无法继续升级');
        const newLevel = num(g.level) + 1;
        const costMoney = (newLevel - 1) * (newLevel - 2) * 2;
        const costExploit = (newLevel - 1) * (newLevel - 2);
        const oldMoney = clamp0(role.money);
        const oldExploit = clamp0(role.exploit);
        if (oldMoney < costMoney) return fail('银子不足');
        if (oldExploit < costExploit) return fail('功勋不足');
        setMoney(oldMoney - costMoney);
        setExploit(oldExploit - costExploit);
        g.level = newLevel;
        touch();
        // 客户端会根据 (level-1)*(level-2) 自行再扣一次，所以返回旧值
        return ok({ money: oldMoney, exploit: oldExploit, id: g.id, level: newLevel });
      }
      case 10005: { // 武将进化
        const g = armyFind(save, req.id);
        if (!g) return fail('武将不存在');
        if (num(g.evolution) >= 10) return fail('武将已经为进化上限');
        const info = generals[g.code] || {};
        const item = bagFind(save, info.proto);
        if (!item) return fail('缺少进化材料');
        const oldMoney = clamp0(role.money);
        if (oldMoney < 1000) return fail('银子不足');
        setMoney(oldMoney - 1000);
        bagSet(save, info.proto, bagCount(save, info.proto) - 1);
        touch();
        let advanced = false;
        if (chance(jinhuaRate(g.evolution))) {
          if (num(info.type) !== 0 && num(g.evolution) === 0) g.feature = randInt(1, 4);
          g.evolution = num(g.evolution) + 1;
          advanced = true;
          touch();
        }
        return ok({
          money: clamp0(role.money),
          itemID: item.id,
          general: advanced ? {
            id: g.id, code: g.code, level: g.level, evolution: g.evolution,
            feature: g.feature, genius: g.genius || null, kezhi: g.kezhi || '',
          } : null,
        });
      }
      case 10006: { // 克制进阶
        const g = armyFind(save, req.id);
        if (!g) return fail('武将不存在');
        const index = num(req.index);
        if (index < 0 || index > 2) return fail('参数错误');
        const item = bagFind(save, 'proto_3_4');
        if (!item) return fail('缺少克制进阶符');
        const oldMoney = clamp0(role.money);
        const oldExploit = clamp0(role.exploit);
        if (oldMoney < 1000) return fail('银子不足');
        if (oldExploit < 1000) return fail('功勋不足');
        setMoney(oldMoney - 1000);
        setExploit(oldExploit - 1000);
        bagSet(save, 'proto_3_4', bagCount(save, 'proto_3_4') - 1);
        touch();
        const levels = kezhiLevels(g.kezhi);
        let advanced = false;
        if (chance(kezhiRate(levels[index].level))) {
          levels[index].level += 1;
          g.kezhi = kezhiString(levels);
          advanced = true;
          touch();
        }
        return ok({
          money: clamp0(role.money),
          exploit: clamp0(role.exploit),
          itemID: item.id,
          index,
          general: advanced ? {
            id: g.id, code: g.code, level: g.level, evolution: g.evolution,
            feature: g.feature, genius: g.genius || null, kezhi: g.kezhi || '',
          } : null,
        });
      }
      case 10007: { // 天赋
        const g = armyFind(save, req.id);
        if (!g) return fail('武将不存在');
        if (!g.genius) {
          g.genius = pick(['tf_1', 'tf_4', 'tf_7', 'tf_10', 'tf_13', 'tf_16', 'tf_19']);
          touch();
          return ok({
            dianka: clamp0(save.dianka),
            general: genPayload(g),
          });
        }
        const dk = clamp0(save.dianka);
        if (dk < 100) return fail('点卡不足');
        setDianka(dk - 100);
        g.genius = 'tf_' + randInt(1, 21);
        touch();
        return ok({ dianka: clamp0(save.dianka), general: genPayload(g) });
      }
      case 10020: { // 属性重洗
        const g = armyFind(save, req.id);
        if (!g) return fail('武将不存在');
        const dk = clamp0(save.dianka);
        if (dk < 100) return fail('点卡不足');
        setDianka(dk - 100);
        g.feature = randInt(1, 4);
        touch();
        return ok({ dianka: clamp0(save.dianka), feature: g.feature });
      }

      /* ===== 招募 ===== */
      case 10001: { // 普通招募
        const code = String(req.code || '');
        const info = generals[code];
        if (!info) return fail('武将不存在');
        const oldMoney = clamp0(role.money);
        const oldRev = clamp0(role.reverence);
        if (oldMoney < 1000) return fail('银子不足');
        if (oldRev < 1000) return fail('声望不足');
        setMoney(oldMoney - 1000);
        setReverence(oldRev - 1000);
        let g = null;
        if (chance(num(info.jinbi) / 100)) {
          g = newGeneral(save, code, role.level > 50 ? 30 : 1, 0, 0, null, info.kezhi, generals);
          addGeneral(save, g);
          touch();
        }
        return ok({ money: clamp0(role.money), reverence: clamp0(role.reverence), general: g ? genPayload(g) : null });
      }
      case 10002: { // 求贤招募
        const code = String(req.code || '');
        const info = generals[code];
        if (!info) return fail('武将不存在');
        if (bagCount(save, 'proto_3_3') < 1) return fail('缺少求贤令');
        const oldRev = clamp0(role.reverence);
        if (oldRev < 1000) return fail('声望不足');
        setReverence(oldRev - 1000);
        bagSet(save, 'proto_3_3', bagCount(save, 'proto_3_3') - 1);
        let g = null;
        if (chance(num(info.coint) / 100)) {
          g = newGeneral(save, code, role.level > 50 ? 30 : 1, 0, 0, null, info.kezhi, generals);
          addGeneral(save, g);
          touch();
        }
        return ok({ reverence: clamp0(role.reverence), dianka: clamp0(save.dianka), general: g ? genPayload(g) : null });
      }
      case 10003: { // 点卡招募
        const code = String(req.code || '');
        const info = generals[code];
        if (!info) return fail('武将不存在');
        const dk = clamp0(save.dianka);
        const oldRev = clamp0(role.reverence);
        if (dk < 20) return fail('点卡不足');
        if (oldRev < 1000) return fail('声望不足');
        setDianka(dk - 20);
        setReverence(oldRev - 1000);
        let g = null;
        if (chance(num(info.coint) / 100)) {
          g = newGeneral(save, code, role.level > 50 ? 30 : 1, 0, 0, null, info.kezhi, generals);
          addGeneral(save, g);
          touch();
        }
        return ok({ dianka: clamp0(save.dianka), reverence: clamp0(role.reverence), general: g ? genPayload(g) : null });
      }

      /* ===== 上阵 ===== */
      case 10008: {
        const choose = String(req.choose || '');
        if (!choose) return fail('至少需要设置一个上阵武将');
        role.choose = choose;
        touch();
        return ok({ choose });
      }

      /* ===== 商城 ===== */
      case 10010: {
        const itemInfo = shop[String(req.shopID || '')];
        if (!itemInfo) return fail('商品不存在');
        const price = num(itemInfo.price);
        const count = num(itemInfo.count) || 1;
        if (bagCount(save, itemInfo.code) + count > 99) return fail('物品叠加数量超过上限，无法购买');
        if (itemInfo.payType === 1) {
          if (clamp0(role.money) < price) return fail('银子不足');
          setMoney(clamp0(role.money) - price);
        } else if (itemInfo.payType === 2) {
          if (clamp0(save.dianka) < price) return fail('点卡不足');
          setDianka(clamp0(save.dianka) - price);
        } else if (itemInfo.payType === 3) {
          if (clamp0(role.exploit) < price) return fail('功勋不足');
          setExploit(clamp0(role.exploit) - price);
        } else if (itemInfo.payType === 4) {
          if (clamp0(role.reverence) < price) return fail('声望不足');
          setReverence(clamp0(role.reverence) - price);
        } else {
          return fail('商品价格配置错误');
        }
        const existing = bagFind(save, itemInfo.code);
        const item = bagSet(save, itemInfo.code,
          bagCount(save, itemInfo.code) + count,
          existing ? existing.id : randInt(1000, 999999));
        touch();
        return ok({
          money: clamp0(role.money), dianka: clamp0(save.dianka),
          exploit: clamp0(role.exploit), reverence: clamp0(role.reverence),
          item: { id: item.id, code: item.code, count: num(item.count) },
        });
      }

      /* ===== 战斗 ===== */
      case 10011: { // 关卡战斗结果
        const part = num(req.part);
        const level = num(req.level);
        const stage = stages.byKey[part + '_' + level];
        if (!stage) return fail('关卡不存在');
        if (!save.process) save.process = {};
        const proc = save.process;
        let first;
        if (part === WULIN_PART) {
          // 乌林遗迹：gate id 201~210，按顺序通关，进度存 finished
          if (level < 1 || level > WULIN_LEVELS) return fail('关卡不存在');
          if (stage.id !== WULIN_FIRST_GATE_ID + level - 1) return fail('关卡配置错误');
          const finished = idList(proc.finished);
          if (level > 1 && finished.indexOf(stage.id - 1) === -1) {
            return fail('关卡尚未解锁，请先完成上一关');
          }
          first = finished.indexOf(stage.id) === -1;
          if (first) {
            finished.push(stage.id);
            finished.sort((a, b) => a - b);
            proc.finished = finished.join('|');
          }
        } else if (part === BIGMAP_PART) {
          // 大地图：进度独立存 bigMapFinished（1~9），不写进 finished
          if (level < 1 || level > BIGMAP_LEVELS) return fail('关卡不存在');
          const big = idList(proc.bigMapFinished);
          if (level > 1 && big.indexOf(level - 1) === -1) {
            return fail('关卡尚未解锁，请先完成上一关');
          }
          first = big.indexOf(level) === -1;
          if (first) {
            big.push(level);
            big.sort((a, b) => a - b);
            proc.bigMapFinished = big.join('|');
          }
        } else {
          // 主线：必须按顺序通关，拒绝跳关
          if (stage.id > maxNormalFinished(save) + 1) {
            return fail('关卡尚未解锁，请先完成上一关');
          }
          const finished = idList(proc.finished);
          first = finished.indexOf(stage.id) === -1;
          if (first) {
            finished.push(stage.id);
            finished.sort((a, b) => a - b);
            proc.finished = finished.join('|');
          }
        }
        const baseMoney = moneyByFight(req.m, req.n);
        const baseExploit = exploitByFight(req.m, req.n);
        const baseRev = reverenceByFight(req.m, req.n);
        let totalMoney = clamp0(role.money) + baseMoney;
        let totalExploit = clamp0(role.exploit) + baseExploit;
        let totalRev = clamp0(role.reverence) + baseRev;
        let award = null;
        if (first) {
          const a = stage.award;
          let aMoney = num(a.money);
          let aExploit = num(a.exploit);
          let aRev = num(a.reverence);
          totalMoney += aMoney;
          totalExploit += aExploit;
          totalRev += aRev;
          const soldier = [];
          for (const code of String(a.soldier || '').split(/[|,]/).map((s) => s.trim()).filter(Boolean)) {
            const g = newGeneral(save, code, 1, 0, 0, null, '', generals);
            addGeneral(save, g);
            soldier.push({
              id: g.id, code: g.code, level: g.level, evolution: g.evolution,
              feature: g.feature, genius: g.genius, kezhi: g.kezhi,
            });
          }
          const item = [];
          for (const seg of String(a.proto || '').split('|').map((s) => s.trim()).filter(Boolean)) {
            const p = seg.split(':');
            const code = p[0];
            const cnt = num(p[1]) || 1;
            const b = bagSet(save, code, bagCount(save, code) + cnt);
            item.push({ id: b.id, code, count: num(b.count) });
          }
          award = {
            money: aMoney, exploit: aExploit, reverence: aRev,
            soldier, item, recruit: a.recruit || '',
          };
        }
        setMoney(totalMoney); setExploit(totalExploit); setReverence(totalRev);
        if (part !== BIGMAP_PART && part !== WULIN_PART && level > num(role.level)) { role.level = level; touch(); }
        touch();
        console.log('[fight] user=' + userID + ' part=' + part + ' level=' + level +
          ' id=' + stage.id + ' first=' + first +
          ' finished=' + (proc.finished || '') + ' bigMap=' + (proc.bigMapFinished || ''));
        return ok({
          part, level,
          money: baseMoney, exploit: baseExploit, reverence: baseRev,
          m: clamp0(role.money), e: clamp0(role.exploit), r: clamp0(role.reverence),
          finished: proc.finished || '',
          bigMapFinished: proc.bigMapFinished || '',
          award,
        });
      }
      case 10012: { // P2P 战斗结果
        const flag = num(req.flag);
        const m = num(req.m);
        const n = num(req.n);
        console.log('[p2p] user=' + userID + ' flag=' + flag + ' m=' + m + ' n=' + n +
          ' relative=' + String(req.relativeName || ''));
        let money = clamp0(role.money);
        let exploit = clamp0(role.exploit);
        let rev = clamp0(role.reverence);
        let win = num(role.winCount);
        let lost = num(role.lostCount);
        if (flag === 1) {
          money += moneyByFight(m, n);
          exploit += exploitByFight(m, n);
          rev += reverenceByFight(m, n);
          win += 1;
        } else if (flag === 0) {
          lost += 1;
        } else {
          money += 50; exploit += 200; rev += 10;
        }
        setMoney(money); setExploit(exploit); setReverence(rev);
        role.winCount = win; role.lostCount = lost;
        touch();
        return ok({
          flag, relativeName: String(req.relativeName || ''),
          money: clamp0(role.money), exploit: clamp0(role.exploit), reverence: clamp0(role.reverence),
          winCount: win, lostCount: lost,
        });
      }
      case 10013: { // 使用道具 / 弹药 / 喇叭
        const id = Number(req.id);
        const b = bagById(save, id);
        if (!b) return fail('道具不存在');
        bagSet(save, b.code, Math.max(0, num(b.count) - 1));
        touch();
        return ok({ itemID: id });
      }
      case 10014: { // 保存战斗历史
        const history = String(req.history || '');
        if (!save.process) save.process = {};
        save.process.history = history;
        touch();
        return ok({ history });
      }
      case 10015: { // 验证码奖励
        const money = clamp0(role.money) + 500;
        setMoney(money);
        return ok({ money: clamp0(role.money) });
      }

      /* ===== 副本 ===== */
      case 10016:
      case 10043:
      case 10050:
      case 10052: {
        const stageID = num(req.stageID);
        const counts = dailyFuben(userID, stageID);
        saveMeta();
        return ok({ stageID, count: num(counts[String(stageID)]) });
      }
      case 10017:
      case 10042:
      case 10051:
      case 10053: {
        const stageID = num(req.stageID);
        const proto = num(req.proto);
        if (proto === 1) {
          const need = stageID === 4 ? 'proto_3_5' : 'proto_3_2';
          if (bagCount(save, need) < 1) return fail('没有副本通行令');
          bagSet(save, need, bagCount(save, need) - 1);
          touch();
        } else {
          const counts = dailyFuben(userID, stageID);
          const key = String(stageID);
          if (num(counts[key]) <= 0) return fail('今日挑战次数已用完');
          counts[key] = num(counts[key]) - 1;
          saveMeta();
        }
        return ok({ stageID, proto });
      }
      case 10018:
      case 10044: { // 副本结算
        const index = num(req.index);
        const level = num(req.level);
        const result = num(req.result);
        let dMoney = 0, dExploit = 0, dRev = 0;
        if (index === 1) { dMoney = level * 100; dExploit = level * 50; dRev = level * 50; }
        else if (index === 2) { dMoney = level * 200; dExploit = level * 100; dRev = level * 100; }
        else if (index === 3) { dMoney = level * 300; dExploit = level * 200; dRev = level * 200; }
        if (result === 0) { dMoney = 0; dExploit = 0; dRev = 0; }
        setMoney(clamp0(role.money) + dMoney);
        setExploit(clamp0(role.exploit) + dExploit);
        setReverence(clamp0(role.reverence) + dRev);
        const data = {
          stageID: num(req.stageID), index, result,
          forward: [clamp0(role.money), clamp0(role.exploit), clamp0(role.reverence)],
        };
        if (index === 3) {
          data.pai = ['2|10000', '1|proto_2_1|1', '1|proto_2_6|5', '1|proto_3_1|1', '1|proto_3_3|1', '1|proto_3_4|1'];
        }
        return ok(data);
      }
      case 10019:
      case 10045:
      case 10048:
      case 10049: { // 翻牌
        const parts = String(req.result || '').split('|');
        if (parts[0] === '2') {
          setMoney(clamp0(role.money) + (num(parts[1]) || 0));
          return ok({ money: clamp0(role.money) });
        }
        const code = parts[1] || '';
        const cnt = num(parts[2]) || 1;
        if (!code) return fail('翻牌结果无效');
        const existing = bagFind(save, code);
        const b = bagSet(save, code, bagCount(save, code) + cnt, existing ? existing.id : randInt(1000, 999999));
        touch();
        return ok({ item: { id: b.id, code: b.code, count: num(b.count) } });
      }

      /* ===== 活动 / 奖励 ===== */
      case 10021: { // 充值活动奖励
        const m = userMeta(userID);
        if (m.getAwardClaimed) return fail('该奖励已领取');
        m.getAwardClaimed = true;
        saveMeta();
        const money = clamp0(role.money) + 100;
        const exploit = clamp0(role.exploit) + 100;
        setMoney(money); setExploit(exploit);
        const gen = [];
        for (const code of ['general_9_34', 'general_9_16']) {
          const g = newGeneral(save, code, 10, 0, 0, null, '', generals);
          addGeneral(save, g);
          gen.push(genPayload(g));
        }
        const item = [];
        for (const [code, cnt] of [['proto_3_3', 3], ['proto_3_1', 3]]) {
          const b = bagSet(save, code, bagCount(save, code) + cnt);
          item.push({ id: b.id, code, count: num(b.count) });
        }
        touch();
        return ok({ general: gen, item, money: clamp0(role.money), exploit: clamp0(role.exploit) });
      }
      case 10022: { // 补偿
        const m = userMeta(userID);
        if (m.buchangClaimed) return fail('该补偿已领取');
        m.buchangClaimed = true;
        saveMeta();
        setMoney(clamp0(role.money) + 1000);
        setExploit(clamp0(role.exploit) + 200);
        setReverence(clamp0(role.reverence) + 300);
        const b = bagSet(save, 'proto_3_2', bagCount(save, 'proto_3_2') + 19);
        const g = newGeneral(save, 'general_4_19', 1, 0, 0, null, '6:1|1:1|8:1', generals);
        g.id = 3000;
        if (!armyFind(save, g.id)) addGeneral(save, g);
        touch();
        return ok({
          money: clamp0(role.money), exploit: clamp0(role.exploit), reverence: clamp0(role.reverence),
          item: [{ id: b.id, code: b.code, count: num(b.count) }],
          general: [{ id: g.id, code: g.code, name: (generals[g.code] || {}).name || '', level: g.level, evolution: g.evolution, feature: g.feature, genius: g.genius, kezhi: g.kezhi }],
        });
      }
      case 10040: { // 领取补偿点卡
        const m = userMeta(userID);
        if (m.lingDiankaClaimed) return fail('该补偿已领取');
        m.lingDiankaClaimed = true;
        saveMeta();
        setDianka(clamp0(save.dianka) + 100);
        return ok({ dianka: clamp0(save.dianka) });
      }
      case 10041: { // 国庆活动
        return ok({ money: clamp0(role.money), exploit: clamp0(role.exploit), dianka: clamp0(save.dianka) });
      }
      case 10046: { // 登录奖励：客户端自行结算，这里只做校验
        if (num(role.level) < 30) return fail('君主等级达到30级才可领取登录奖励');
        return ok({});
      }
      case 10047: { // 每日任务面板
        if (num(role.level) < 30) return fail('君主等级达到30级才可领取每日任务');
        return ok({});
      }
      case 9998: { // 旧 4399 激活
        return ok({});
      }

      /* ===== 擂台 ===== */
      case 10030: { // 擂台列表
        return ok({
          rongyu: clamp0(role.rongyu) || 100045,
          ranking: num(role.ranking) || 32,
          leitai: leitaiData,
          paihang,
        });
      }
      case 10031: { // 刷新
        return ok({ leitai: leitaiData });
      }
      case 10032: { // 成为擂主
        const room = leitaiByRID(req.rID);
        if (!room) return fail('房间号错误');
        let money = clamp0(role.money);
        let exploit = clamp0(role.exploit);
        let dianka = clamp0(save.dianka);
        if (room.rType === 1) {
          if (money < num(room.rPrice)) return fail('银子不足');
          money -= num(room.rPrice);
        } else if (room.rType === 2) {
          if (exploit < num(room.rPrice)) return fail('功勋不足');
          exploit -= num(room.rPrice);
        } else if (room.rType === 3) {
          if (dianka < num(room.rPrice)) return fail('点卡不足');
          dianka -= num(room.rPrice);
        }
        setMoney(money); setExploit(exploit); setDianka(dianka);
        room.rStatus = 1;
        room.paid = { type: room.rType, price: num(room.rPrice), id: role.roleID };
        room.mInfo = { id: role.roleID, pID: String(req.pID || ''), roleName: role.roleName, level: role.level, imageID: role.imageID };
        return ok({
          rID: room.rID, money: clamp0(role.money), exploit: clamp0(role.exploit),
          dianka: clamp0(save.dianka), rongyu: clamp0(role.rongyu), leitai: leitaiData,
        });
      }
      case 10033: { // 退出擂主
        const room = leitaiByRID(req.rID);
        if (room && room.mInfo && Number(room.mInfo.id) === Number(role.roleID)) {
          // 退还报名费（与客户端“报名费将返还给您”的提示一致）
          const paid = room.paid;
          if (paid && Number(paid.id) === Number(role.roleID)) {
            if (paid.type === 1) setMoney(clamp0(role.money) + num(paid.price));
            else if (paid.type === 2) setExploit(clamp0(role.exploit) + num(paid.price));
            else if (paid.type === 3) setDianka(clamp0(save.dianka) + num(paid.price));
          }
          room.rStatus = 0;
          room.rCount = 0;
          room.rValue = 0;
          room.mInfo = null;
          room.paid = null;
        }
        return ok({
          rID: room ? room.rID : num(req.rID),
          money: clamp0(role.money), exploit: clamp0(role.exploit),
          dianka: clamp0(save.dianka), rongyu: clamp0(role.rongyu),
          ranking: num(role.ranking) || 32,
          leitai: leitaiData,
        });
      }
      case 10034: { // 攻擂
        const room = leitaiByRID(req.rID);
        if (!room) return fail('房间号错误');
        // 擂台的战斗是客户端 P2P 直连，服务端只保存房间信息。
        // 当前服务端没有实时在线玩家配对，直接返回失败避免客户端连到空 peer。
        if (!room.mInfo || !room.mInfo.pID) return fail('该擂台暂无擂主，请先成为擂主或稍后再试');
        return fail('该擂台暂不支持远程攻擂');
      }
      case 10035: { // 继续守擂
        const room = leitaiByRID(req.rID);
        if (!room) return fail('房间号错误');
        return ok({
          rID: room.rID, type: req.type,
          money: clamp0(role.money), exploit: clamp0(role.exploit),
          dianka: clamp0(save.dianka), rongyu: clamp0(role.rongyu), leitai: leitaiData,
        });
      }
      case 10036: { // 擂台战斗结束
        const win = num(req.win);
        let money = clamp0(role.money), exploit = clamp0(role.exploit);
        let dianka = clamp0(save.dianka), rongyu = clamp0(role.rongyu);
        if (win === 1) { money += 500; exploit += 500; rongyu += 100; }
        else if (win === 2) { money += 100; exploit += 100; rongyu += 20; }
        setMoney(money); setExploit(exploit); setDianka(dianka);
        role.rongyu = rongyu;
        touch();
        return ok({
          win, relativeName: String(req.relativeName || ''),
          money: clamp0(role.money), exploit: clamp0(role.exploit),
          dianka: clamp0(save.dianka), rongyu, rID: num(req.rID), leitai: leitaiData,
        });
      }
      case 10037: { // 心跳（sendJSONToURL，无返回）
        return ok({});
      }
      case 10038: { // 排行榜
        return ok({ paihang });
      }
      case 10039: { // 放弃攻擂
        return ok({
          money: clamp0(role.money), exploit: clamp0(role.exploit), dianka: clamp0(save.dianka),
          rongyu: clamp0(role.rongyu), ranking: num(role.ranking) || 32,
          leitai: leitaiData,
        });
      }

      default:
        return fail('服务器未实现该协议 head=' + head);
    }
  }

  function genPayload(g) {
    return {
      id: g.id, code: g.code, level: g.level, evolution: g.evolution,
      feature: g.feature, genius: g.genius || null, kezhi: g.kezhi || '',
      name: (generals[g.code] || {}).name || '',
    };
  }

  return {
    handle,
    shop,
    generals,
    stages,
    // 供测试 / 调试
    _meta: () => meta,
  };
}

module.exports = { createGameService, normalizeSave, mergeProgress };
