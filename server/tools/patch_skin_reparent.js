'use strict';
/**
 * 把 SymbolClass 目标类的父类改成模板类（例如 generalSkin_13_0）。
 *
 * 只修改 instance_info 的 superName 字段。若新旧 superName 的 u30 编码长度
 * 相同（通常都是 1~2 字节），就是原地替换，不改变 ABC/SWF 大小，风险最低。
 *
 * 用法（默认 dry-run）：
 *   node tools/patch_skin_reparent.js --swf ../general.swf \
 *     --template generalSkin_13_0 \
 *     --targets generalSkin_26_0,generalSkin_26_1 --apply
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { Abc } = require('./abc-parser.js');

const argv = process.argv.slice(2);
function arg(v) { const i = argv.indexOf(v); return i >= 0 ? argv[i + 1] : null; }
const swfPath = path.resolve(arg('--swf') || path.join(__dirname, '..', '..', 'general.swf'));
const templateName = arg('--template') || 'generalSkin_13_0';
const superNameArg = arg('--super'); // 直接用某个 multiname 作为父类，例如 flash.display::MovieClip
const targetNames = String(arg('--targets') || '').split(',').map((s) => s.trim()).filter(Boolean);
const apply = argv.includes('--apply');
if (!targetNames.length) { console.error('缺少 --targets'); process.exit(1); }

function readSwf(file) {
  const raw = fs.readFileSync(file);
  const sig = raw.toString('ascii', 0, 3);
  if (sig !== 'CWS' && sig !== 'FWS') throw new Error('不支持的 SWF 签名: ' + sig);
  const version = raw[3];
  const body = sig === 'CWS' ? zlib.inflateSync(raw.subarray(8)) : raw.subarray(8);
  if (body.length !== raw.readUInt32LE(4) - 8) throw new Error('SWF 长度不一致');
  return { version, body };
}
function writeSwf(file, version, body) {
  const header = Buffer.alloc(8);
  header.write('CWS', 0, 'ascii');
  header[3] = version;
  header.writeUInt32LE(body.length + 8, 4);
  fs.writeFileSync(file, Buffer.concat([header, zlib.deflateSync(body, { level: 9 })]));
}
function buildTag(code, data) {
  if (data.length >= 0x3f) {
    const h = Buffer.alloc(6);
    h.writeUInt16LE((code << 6) | 0x3f, 0);
    h.writeUInt32LE(data.length, 2);
    return Buffer.concat([h, data]);
  }
  const h = Buffer.alloc(2);
  h.writeUInt16LE((code << 6) | data.length, 0);
  return Buffer.concat([h, data]);
}
function topTags(body) {
  let p = 0;
  const nbits = (body[0] >> 3) & 0x1f;
  p += Math.ceil((5 + 4 * nbits) / 8) + 4;
  const tags = [];
  while (p < body.length) {
    const tagStart = p;
    const raw = body.readUInt16LE(p);
    const code = raw >> 6;
    let len = raw & 0x3f;
    let headerLen = 2;
    if (len === 0x3f) { len = body.readUInt32LE(p + 2); headerLen = 6; }
    tags.push({ code, tagStart, headerLen, dataStart: p + headerLen, len });
    if (code === 0) break;
    p += headerLen + len;
  }
  return tags;
}
function findDoAbc(body) {
  for (const t of topTags(body)) {
    if (t.code !== 82) continue;
    const flags = body.readUInt32LE(t.dataStart);
    let q = t.dataStart + 4;
    while (body[q] !== 0) q++;
    const name = body.subarray(t.dataStart + 4, q).toString('utf8');
    return { tag: t, flags, name, abcStart: q + 1, abcEnd: t.dataStart + t.len };
  }
  throw new Error('没有找到 DoABC tag');
}
class Reader {
  constructor(b) { this.b = b; this.p = 0; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  f64() { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  u30() { let v = 0, sh = 0; for (let i = 0; i < 5; i++) { const x = this.b[this.p++]; v |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; } return v >>> 0; }
  utf(n) { const s = this.b.subarray(this.p, this.p + n).toString('utf8'); this.p += n; return s; }
}
function encU30(v) {
  const out = [];
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
function parseTraits(r) {
  const count = r.u30();
  for (let i = 0; i < count; i++) {
    r.u30();
    const kt = r.u8();
    const kind = kt & 0x0f;
    const attrs = kt >> 4;
    if (kind === 0 || kind === 6) { r.u30(); r.u30(); const vi = r.u30(); if (vi) r.u8(); }
    else if (kind === 4) { r.u30(); r.u30(); }
    else { r.u30(); r.u30(); }
    if (attrs & 0x04) { const mc = r.u30(); for (let j = 0; j < mc; j++) r.u30(); }
  }
}
function parseInstanceTable(abcBytes) {
  const r = new Reader(abcBytes);
  r.u16(); r.u16();
  let n = r.u30(); for (let i = 1; i < n; i++) r.u30();
  n = r.u30(); for (let i = 1; i < n; i++) r.u30();
  n = r.u30(); for (let i = 1; i < n; i++) r.f64();
  n = r.u30(); for (let i = 1; i < n; i++) r.utf(r.u30());
  n = r.u30(); for (let i = 1; i < n; i++) { r.u8(); r.u30(); }
  n = r.u30(); for (let i = 1; i < n; i++) { const c = r.u30(); for (let j = 0; j < c; j++) r.u30(); }
  n = r.u30(); for (let i = 1; i < n; i++) {
    const kind = r.u8();
    switch (kind) {
      case 0x07: case 0x0d: r.u30(); r.u30(); break;
      case 0x0f: case 0x10: r.u30(); break;
      case 0x11: case 0x12: break;
      case 0x09: case 0x0e: r.u30(); r.u30(); break;
      case 0x1b: case 0x1c: r.u30(); break;
      case 0x1d: { r.u30(); const c = r.u30(); for (let j = 0; j < c; j++) r.u30(); break; }
      default: throw new Error('未知 multiname kind 0x' + kind.toString(16));
    }
  }
  n = r.u30(); for (let i = 0; i < n; i++) {
    const pc = r.u30(); r.u30();
    for (let j = 0; j < pc; j++) r.u30();
    r.u30();
    const flags = r.u8();
    if (flags & 0x08) { const oc = r.u30(); for (let j = 0; j < oc; j++) { r.u30(); r.u8(); } }
    if (flags & 0x80) for (let j = 0; j < pc; j++) r.u30();
  }
  n = r.u30(); for (let i = 0; i < n; i++) { r.u30(); const c = r.u30(); for (let j = 0; j < c; j++) r.u30(); for (let j = 0; j < c; j++) r.u30(); }
  const count = r.u30();
  const entries = [];
  for (let i = 0; i < count; i++) {
    const start = r.p;
    const name = r.u30();
    const superPos = r.p;
    const superName = r.u30();
    const superEnd = r.p;
    const flags = r.u8();
    if (flags & 0x08) r.u30();
    const ic = r.u30();
    for (let j = 0; j < ic; j++) r.u30();
    const iinit = r.u30();
    parseTraits(r);
    entries.push({ i, start, end: r.p, name, superName, superPos, superEnd, flags, iinit });
  }
  return entries;
}

const { version, body } = readSwf(swfPath);
const doabc = findDoAbc(body);
const abcBytes = Buffer.from(body.subarray(doabc.abcStart, doabc.abcEnd));
const abc = new Abc(Buffer.from(abcBytes));
const entries = parseInstanceTable(abcBytes);
const idxByName = (name) => abc.instances.findIndex((inst) => abc.mnName(inst.name) === name);

let templateNameIdx;
let expectedSuperName;
if (superNameArg) {
  templateNameIdx = -1;
  for (let i = 0; i < abc.multinames.length; i++) {
    if (abc.mnName(i) === superNameArg) { templateNameIdx = i; break; }
  }
  if (templateNameIdx < 0) throw new Error('找不到父类 multiname: ' + superNameArg);
  expectedSuperName = superNameArg;
  console.log('父类直接指定为 ' + superNameArg + ': multiname #' + templateNameIdx);
} else {
  const templateIdx = idxByName(templateName);
  if (templateIdx < 0) throw new Error('找不到模板类: ' + templateName);
  templateNameIdx = abc.instances[templateIdx].name;
  expectedSuperName = templateName;
  console.log('模板 ' + templateName + ': class-name multiname #' + templateNameIdx);
}

const targetIdxs = targetNames.map((n) => {
  const i = idxByName(n);
  if (i < 0) throw new Error('找不到目标类: ' + n);
  return i;
});

const newSuper = encU30(templateNameIdx);
for (const i of targetIdxs) {
  const e = entries[i];
  const oldEnc = abcBytes.subarray(e.superPos, e.superEnd);
  console.log(abc.mnName(e.name) + ': super #' + e.superName + ' (' + abc.mnName(e.superName) + ')' +
    ' @' + e.superPos + ' len=' + oldEnc.length + ' -> #' + templateNameIdx + ' len=' + newSuper.length);
  if (oldEnc.length !== newSuper.length) {
    throw new Error('superName u30 长度不同，不能原地替换；请改用重建方案');
  }
}

if (!apply) {
  console.log('dry-run：未写盘。加 --apply 才会保存。');
  process.exit(0);
}

for (const i of targetIdxs) {
  const e = entries[i];
  newSuper.copy(abcBytes, e.superPos);
}

const nameBytes = Buffer.from(doabc.name + '\0', 'utf8');
const flagsBuf = Buffer.alloc(4);
flagsBuf.writeUInt32LE(doabc.flags, 0);
const newTag = buildTag(82, Buffer.concat([flagsBuf, nameBytes, abcBytes]));
const newBody = Buffer.concat([
  body.subarray(0, doabc.tag.tagStart),
  newTag,
  body.subarray(doabc.tag.dataStart + doabc.tag.len),
]);

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = swfPath + '.bak-reparent-' + stamp;
fs.copyFileSync(swfPath, backup);
writeSwf(swfPath, version, newBody);
console.log('已备份: ' + backup);
console.log('已写入: ' + swfPath);

const check = readSwf(swfPath);
const checkDoAbc = findDoAbc(check.body);
const checkAbc = new Abc(Buffer.from(check.body.subarray(checkDoAbc.abcStart, checkDoAbc.abcEnd)));
for (const name of targetNames) {
  const i = checkAbc.instances.findIndex((inst) => checkAbc.mnName(inst.name) === name);
  const inst = checkAbc.instances[i];
  console.log('校验 ' + name + ': super=' + checkAbc.mnName(inst.superName) + ' iinit=' + inst.iinit + ' traits=' + inst.traits.length);
  if (checkAbc.mnName(inst.superName) !== expectedSuperName) throw new Error(name + ' 父类不是 ' + expectedSuperName);
}
console.log('校验通过。');
