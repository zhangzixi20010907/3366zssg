'use strict';
/**
 * 把 general.swf 中某个 SymbolClass 目标类的 instance_info 替换成模板类的
 * instance_info（只保留目标自己的类名）。
 *
 * 典型用途：复制出来的 generalSkin_26_0/26_1 被工具创建成了 Object 子类的空壳，
 * 需要变成和 generalSkin_13_0 一样的 flash.display.MovieClip 子类，并继承它的
 * iinit（addFrameScript）和帧脚本 traits。
 *
 * 用法（默认 dry-run）：
 *   node tools/patch_skin_class.js --swf ../general.swf \
 *     --template generalSkin_13_0 \
 *     --targets generalSkin_26_0,generalSkin_26_1 --apply
 *
 * 注意：ABC 的实例表会增长，DoABC tag 和 SWF 长度会重新计算；会先备份。
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { Abc } = require('./abc-parser.js');

const argv = process.argv.slice(2);
function arg(v) { const i = argv.indexOf(v); return i >= 0 ? argv[i + 1] : null; }
const swfPath = path.resolve(arg('--swf') || path.join(__dirname, '..', '..', 'general.swf'));
const templateName = arg('--template') || 'generalSkin_13_0';
const targetNames = String(arg('--targets') || '').split(',').map((s) => s.trim()).filter(Boolean);
const apply = argv.includes('--apply');
if (!targetNames.length) { console.error('缺少 --targets'); process.exit(1); }

/* ---------------- SWF 读取 / 写入 ---------------- */
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

/* ---------------- ABC 足够解析到 instance_info ---------------- */
class Reader {
  constructor(b) { this.b = b; this.p = 0; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.b.readUInt16LE(this.p); this.p += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.p); this.p += 4; return v; }
  f64() { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  u30() { let v = 0, sh = 0; for (let i = 0; i < 5; i++) { const x = this.b[this.p++]; v |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; } return v >>> 0; }
  utf(n) { const s = this.b.subarray(this.p, this.p + n).toString('utf8'); this.p += n; return s; }
  skip(n) { this.p += n; }
}
function encU30(v) {
  const out = [];
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
function parseTraits(r) {
  const count = r.u30();
  for (let i = 0; i < count; i++) {
    r.u30(); // name
    const kt = r.u8();
    const kind = kt & 0x0f;
    const attrs = kt >> 4;
    if (kind === 0 || kind === 6) {
      r.u30(); r.u30();
      const vi = r.u30();
      if (vi) r.u8();
    } else if (kind === 4) {
      r.u30(); r.u30();
    } else {
      r.u30(); r.u30();
    }
    if (attrs & 0x04) {
      const mc = r.u30();
      for (let j = 0; j < mc; j++) r.u30();
    }
  }
  return count;
}
function parseInstanceTable(abcBytes) {
  const r = new Reader(abcBytes);
  r.u16(); r.u16(); // minor/major
  let n = r.u30(); for (let i = 1; i < n; i++) r.u30(); // int
  n = r.u30(); for (let i = 1; i < n; i++) r.u30(); // uint
  n = r.u30(); for (let i = 1; i < n; i++) r.f64(); // double
  n = r.u30(); for (let i = 1; i < n; i++) r.utf(r.u30()); // string
  n = r.u30(); for (let i = 1; i < n; i++) { r.u8(); r.u30(); } // namespace
  n = r.u30(); for (let i = 1; i < n; i++) { const c = r.u30(); for (let j = 0; j < c; j++) r.u30(); } // ns set
  n = r.u30(); for (let i = 1; i < n; i++) { // multiname
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
  n = r.u30(); for (let i = 0; i < n; i++) { // method
    const pc = r.u30(); r.u30();
    for (let j = 0; j < pc; j++) r.u30();
    r.u30(); // name
    const flags = r.u8();
    if (flags & 0x08) { const oc = r.u30(); for (let j = 0; j < oc; j++) { r.u30(); r.u8(); } }
    if (flags & 0x80) for (let j = 0; j < pc; j++) r.u30();
  }
  n = r.u30(); for (let i = 0; i < n; i++) { // metadata
    r.u30();
    const c = r.u30();
    for (let j = 0; j < c; j++) r.u30();
    for (let j = 0; j < c; j++) r.u30();
  }
  const count = r.u30();
  const tableStart = r.p; // after count
  const entries = [];
  for (let i = 0; i < count; i++) {
    const start = r.p;
    const name = r.u30();
    const superName = r.u30();
    const flags = r.u8();
    if (flags & 0x08) r.u30();
    const ic = r.u30();
    for (let j = 0; j < ic; j++) r.u30();
    const iinit = r.u30();
    const traits = parseTraits(r);
    entries.push({ i, start, end: r.p, name, superName, flags, iinit, traits });
  }
  return { count, tableStart, tableEnd: r.p, entries };
}

/* ---------------- 主流程 ---------------- */
const { version, body } = readSwf(swfPath);
const doabc = findDoAbc(body);
const abcBytes = body.subarray(doabc.abcStart, doabc.abcEnd);
const abc = new Abc(Buffer.from(abcBytes));
const table = parseInstanceTable(abcBytes);

const idxByName = (name) => abc.instances.findIndex((inst) => abc.mnName(inst.name) === name);
const templateIdx = idxByName(templateName);
if (templateIdx < 0) throw new Error('找不到模板类: ' + templateName);
const targetIdxs = targetNames.map((n) => {
  const i = idxByName(n);
  if (i < 0) throw new Error('找不到目标类: ' + n);
  return i;
});

const src = table.entries[templateIdx];
const srcNameLen = encU30(src.name).length;
const srcRest = abcBytes.subarray(src.start + srcNameLen, src.end);
console.log('模板 ' + templateName + ' instance #' + templateIdx +
  ': nameIdx=' + src.name + ' super=' + abc.mnName(src.superName) +
  ' iinit=' + src.iinit + ' traits=' + src.traits + ' len=' + (src.end - src.start));
console.log('复制出的 traits 段: ' + srcRest.length + ' bytes');

const newEntries = table.entries.map((e) => {
  if (!targetIdxs.includes(e.i)) return abcBytes.subarray(e.start, e.end);
  const nameEnc = encU30(e.name);
  const out = Buffer.concat([nameEnc, srcRest]);
  console.log('目标 ' + abc.mnName(e.name) + ' instance #' + e.i + ': ' +
    (e.end - e.start) + ' -> ' + out.length + ' bytes');
  return out;
});

const newAbc = Buffer.concat([
  abcBytes.subarray(0, table.tableStart),
  ...newEntries,
  abcBytes.subarray(table.tableEnd),
]);
console.log('ABC: ' + abcBytes.length + ' -> ' + newAbc.length + ' bytes');

if (!apply) {
  console.log('dry-run：未写盘。加 --apply 才会保存。');
  process.exit(0);
}

const oldTag = doabc.tag;
const nameBytes = Buffer.from(doabc.name + '\0', 'utf8');
const flagsBuf = Buffer.alloc(4);
flagsBuf.writeUInt32LE(doabc.flags, 0);
const newTagData = Buffer.concat([flagsBuf, nameBytes, newAbc]);
const newTag = buildTag(82, newTagData);

const chunks = [];
chunks.push(body.subarray(0, oldTag.tagStart));
chunks.push(newTag);
chunks.push(body.subarray(oldTag.dataStart + oldTag.len));
const newBody = Buffer.concat(chunks);

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = swfPath + '.bak-classfix-' + stamp;
fs.copyFileSync(swfPath, backup);
writeSwf(swfPath, version, newBody);
console.log('已备份: ' + backup);
console.log('已写入: ' + swfPath);

/* ---------------- 回读校验 ---------------- */
const check = readSwf(swfPath);
const checkDoAbc = findDoAbc(check.body);
const checkAbcBytes = check.body.subarray(checkDoAbc.abcStart, checkDoAbc.abcEnd);
const checkAbc = new Abc(Buffer.from(checkAbcBytes));
const checkTable = parseInstanceTable(checkAbcBytes);
for (const name of targetNames) {
  const i = checkAbc.instances.findIndex((inst) => checkAbc.mnName(inst.name) === name);
  const e = checkTable.entries[i];
  console.log('校验 ' + name + ': super=' + checkAbc.mnName(checkAbc.instances[i].superName) +
    ' iinit=' + e.iinit + ' traits=' + e.traits + ' len=' + (e.end - e.start));
  if (checkAbc.mnName(checkAbc.instances[i].superName) !== 'flash.display::MovieClip') {
    throw new Error(name + ' 父类不是 MovieClip，补丁失败');
  }
  if (e.iinit !== src.iinit || e.traits !== src.traits) {
    throw new Error(name + ' 没有继承模板的 iinit/traits，补丁失败');
  }
}
console.log('校验通过。');
