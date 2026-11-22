#!/usr/bin/env node
/**
 * 修复 p2p3 补丁引入的 _isServer 反向问题。
 *
 * 背景：
 *   P2PFight 构造函数里 `_isServer` 决定战斗结束时由谁 p2pSend
 *   RESULT_FROM_SERVER 结算消息（onSoldierDeadCompleteHandler 里
 *   `if (_isServer == true) 才 p2pSend`）。
 *   - 发起方 onFightRequestClickHandler 会设置 ChatManager.server = true
 *   - 接受方 onAgreeFightClickHandler -> p2pConnect(_, false) 使 server = false
 *   所以正确逻辑是 `_isServer = ChatManager.getInstance().server`：
 *   发起方发消息，接受方接收并结算。
 *
 *   p2p3 把构造函数改成了 `_isServer = (direct == -1)`（即 !server），
 *   导致发送方被反转为“接受方发、发起方收”，接受方再也收不到结算消息，
 *   于是接受方战斗结束不弹结算界面。
 *
 * 本工具把目标 SWF 中 P2PFight 构造函数的方法体替换回参考 SWF（p2p3 之前）的版本。
 *
 * 用法：
 *   node tools/patch_p2p_isserver.js --swf ../main.swf --ref ../main.swf.bak-p2p3-<ts> [--out ../main.swf] [--no-backup]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Abc } = require('./abc-parser.js');

function arg(v) { const i = process.argv.indexOf(v); return i >= 0 ? process.argv[i + 1] : null; }
const has = (v) => process.argv.includes(v);

// ---- SWF 读写 ----
function readSwf(file) {
  const b = fs.readFileSync(file);
  const sig = b.toString('ascii', 0, 3);
  const version = b[3];
  const body = sig === 'CWS' ? zlib.inflateSync(b.subarray(8)) : b.subarray(8);
  // 找到 DoABC tag（82）
  let p = 0;
  const nbits = (body[0] >> 3) & 0x1f;
  p += Math.ceil((5 + 4 * nbits) / 8) + 4;
  while (p < body.length) {
    const hdr = p;
    const raw = body.readUInt16LE(p);
    const code = raw >> 6;
    let len = raw & 0x3f;
    let hl = 2;
    if (len === 0x3f) { len = body.readUInt32LE(p + 2); hl = 6; }
    if (code === 82) {
      const dataStart = p + hl;
      let q = dataStart + 4; // flags(4)
      while (q < dataStart + len && body[q] !== 0) q++; // name C 字符串
      const abcStart = q + 1;
      return { sig, version, body, abcHdr: hdr, abcDataStart: dataStart, abcLen: len, abcStart, abcEnd: dataStart + len };
    }
    p += hl + len;
    if (code === 0) break;
  }
  throw new Error('未找到 DoABC tag: ' + file);
}

function u30enc(v) { const out = []; let x = v >>> 0; do { let b = x & 0x7f; x >>>= 7; if (x) b |= 0x80; out.push(b); } while (x); return Buffer.from(out); }
function buildTagHeader(code, dataLen) {
  if (dataLen <= 0x3f) { const h = Buffer.alloc(2); h.writeUInt16LE(((code & 0x3ff) << 6) | dataLen, 0); return h; }
  const h = Buffer.alloc(6); h.writeUInt16LE(((code & 0x3ff) << 6) | 0x3f, 0); h.writeUInt32LE(dataLen, 2); return h;
}

function findP2PFightCtor(abc) {
  const f = abc.findInstance('game::P2PFight');
  if (!f) throw new Error('找不到 game::P2PFight');
  const body = abc.bodies.find((b) => b.method === f.instance.iinit);
  if (!body) throw new Error('找不到 P2PFight 构造函数方法体');
  return body;
}

function main() {
  const swfPath = path.resolve(arg('--swf') || '');
  const refPath = path.resolve(arg('--ref') || '');
  if (!fs.existsSync(swfPath) || !fs.existsSync(refPath)) { console.error('用法: --swf <目标> --ref <参考(p2p3之前)> [--out] [--no-backup]'); process.exit(1); }

  const tgt = readSwf(swfPath);
  const ref = readSwf(refPath);
  const tAbcBuf = tgt.body.subarray(tgt.abcStart, tgt.abcEnd);
  const rAbcBuf = ref.body.subarray(ref.abcStart, ref.abcEnd);
  const tAbc = new Abc(Buffer.from(tAbcBuf));
  const rAbc = new Abc(Buffer.from(rAbcBuf));

  const tBody = findP2PFightCtor(tAbc);
  const rBody = findP2PFightCtor(rAbc);
  console.log('目标 ' + path.basename(swfPath) + ' P2PFight.<init> codeLen=' + tBody.codeLen + ' maxStack=' + tBody.maxStack + ' maxLocal=' + tBody.maxLocal);
  console.log('参考 ' + path.basename(refPath) + ' P2PFight.<init> codeLen=' + rBody.codeLen + ' maxStack=' + rBody.maxStack + ' maxLocal=' + rBody.maxLocal);

  // 只替换方法体的“codeLen 前缀 + code”这一段（[codeLenPos, codeEnd)）。
  // 两侧 ABC 的命名空间池布局可能不同（导致 body 偏移不同），但只要
  // 多重名按索引解析出的名称一致，构造函数代码里的多重名索引在目标里依然有效。
  if (tBody.maxStack < rBody.maxStack) throw new Error('参考构造函数需要更大 maxStack，无法原地替换');
  if (tBody.maxLocal < rBody.maxLocal) throw new Error('参考构造函数需要更多局部变量槽');
  if (tBody.exceptions.length !== rBody.exceptions.length || tBody.traits.length !== rBody.traits.length) {
    throw new Error('构造函数异常表/traits 不一致');
  }
  // 校验参考代码引用的多重名在目标中解析为同名
  const code = Buffer.from(rBody.code);
  const u30r = (buf, pos) => { let v = 0, sh = 0, pl = pos; for (let i = 0; i < 5; i++) { const x = buf[pl++]; v |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; } return { v: v >>> 0, next: pl }; };
  for (let i = 0; i + 3 < code.length; i++) {
    const op = code[i];
    if (op === 0x60 || op === 0x66 || op === 0x61 || op === 0x67 || op === 0x5d || op === 0x5e) {
      const d = u30r(code, i + 1);
      if (d.v < tAbc.multinames.length && tAbc.mnName(d.v) !== rAbc.mnName(d.v)) {
        throw new Error('多重名 #' + d.v + ' 在两侧不一致，拒绝替换');
      }
    }
  }

  // 用参考版本的 [codeLenPos, codeEnd) 替换目标的 [codeLenPos, codeEnd)
  const newAbc = Buffer.concat([
    tAbcBuf.subarray(0, tBody.codeLenPos),
    rAbcBuf.subarray(rBody.codeLenPos, rBody.codeEnd),
    tAbcBuf.subarray(tBody.codeEnd),
  ]);

  // 追加校验：除构造函数外，其余方法体 code 必须与目标完全一致
  const vAbcAll = new Abc(Buffer.from(newAbc));
  const tCode = new Map(); tAbc.bodies.forEach((b) => tCode.set(b.method, Buffer.from(b.code).toString('hex')));
  for (const b of vAbcAll.bodies) {
    const h = Buffer.from(b.code).toString('hex');
    if (b.method === tBody.method) continue;
    if (tCode.get(b.method) !== h) throw new Error('替换后 method#' + b.method + ' 被意外修改');
  }

  // 验证新 ABC 解析后构造函数 codeLen 正确
  const vAbc = new Abc(Buffer.from(newAbc));
  const vBody = findP2PFightCtor(vAbc);
  if (vBody.codeLen !== rBody.codeLen) throw new Error('重建后 codeLen 校验失败');

  // 重建 DoABC tag 与 SWF body
  const prefix = tgt.body.subarray(tgt.abcDataStart, tgt.abcDataStart + 4); // flags
  let q = tgt.abcDataStart + 4; while (tgt.body[q] !== 0) q++;
  const namePart = tgt.body.subarray(tgt.abcDataStart + 4, q + 1); // name + \0
  const newTagData = Buffer.concat([prefix, namePart, newAbc]);
  const newHeader = buildTagHeader(82, newTagData.length);
  const newBody = Buffer.concat([
    tgt.body.subarray(0, tgt.abcHdr),
    newHeader,
    newTagData,
    tgt.body.subarray(tgt.abcDataStart + tgt.abcLen),
  ]);
  const totalLen = 8 + newBody.length;
  const header = Buffer.alloc(8);
  header.write(tgt.sig, 0, 'ascii');
  header[3] = tgt.version;
  header.writeUInt32LE(totalLen, 4);
  const out = tgt.sig === 'CWS' ? Buffer.concat([header, zlib.deflateSync(newBody, { level: 9 })]) : Buffer.concat([header, newBody]);

  const outPath = arg('--out') ? path.resolve(arg('--out')) : swfPath;
  if (outPath === swfPath && !has('--no-backup')) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = swfPath + '.bak-isserver-' + stamp;
    fs.copyFileSync(swfPath, bak);
    console.log('已备份: ' + bak);
  }
  fs.writeFileSync(outPath, out);
  console.log('已写入: ' + outPath + ' (' + out.length + ' 字节)');
  console.log('修复完成：_isServer = ChatManager.getInstance().server（发起方 p2pSend 结算消息，接受方接收→结算）');
}

try { main(); } catch (e) { console.error('[error] ' + e.message); process.exit(1); }
