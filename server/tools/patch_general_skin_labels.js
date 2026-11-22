'use strict';
/**
 * 修改 general.swf 中指定 DefineSprite 的帧标签（FrameLabel）。
 *
 * 用途：把复制出来的 Boss 动画（_attackBegin1/_attackBegin2 两段攻击）
 * 改成君主类 Junzhu 需要的单套标签：
 *   _attackBegin1 -> _attackBegin
 *   _attackEnd1   -> _attackEnd
 *   _attackBegin2 -> _baojiBegin
 *   _attackEnd2   -> _baojiEnd
 *
 * 用法（默认 dry-run，只打印不写盘）：
 *   node tools/patch_general_skin_labels.js --swf ../general.swf --sprite 1465,1466 --apply
 *
 * 会先备份为 general.swf.bak-skinlabels-<时间戳>，再原地写回。
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const argv = process.argv.slice(2);
function arg(v) { const i = argv.indexOf(v); return i >= 0 ? argv[i + 1] : null; }
const swfPath = path.resolve(arg('--swf') || path.join(__dirname, '..', '..', 'general.swf'));
const spriteIds = new Set(String(arg('--sprite') || '1465,1466').split(',').map((s) => Number(s.trim())).filter(Boolean));
const apply = argv.includes('--apply');

const LABEL_MAP = {
  _attackBegin1: '_attackBegin',
  _attackEnd1: '_attackEnd',
  _attackBegin2: '_baojiBegin',
  _attackEnd2: '_baojiEnd',
};

function readSwf(file) {
  const raw = fs.readFileSync(file);
  const sig = raw.toString('ascii', 0, 3);
  if (sig !== 'CWS' && sig !== 'FWS') throw new Error('不支持的 SWF 签名: ' + sig);
  const version = raw[3];
  const fileLength = raw.readUInt32LE(4);
  const body = sig === 'CWS' ? zlib.inflateSync(raw.subarray(8)) : raw.subarray(8);
  if (body.length !== fileLength - 8) {
    throw new Error('SWF 长度不一致: body=' + body.length + ' header=' + (fileLength - 8));
  }
  return { raw, sig, version, fileLength, body };
}

function writeSwf(file, version, body) {
  const header = Buffer.alloc(8);
  header.write('CWS', 0, 'ascii');
  header[3] = version;
  header.writeUInt32LE(body.length + 8, 4);
  const compressed = zlib.deflateSync(body, { level: 9 });
  fs.writeFileSync(file, Buffer.concat([header, compressed]));
}

// 顶层 tag 遍历：返回 { code, headerLen, dataStart, len, tagStart }
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

function readFrameLabel(tag) {
  let e = tag.dataStart;
  while (e < tag.dataStart + tag.len && body[e] !== 0) e++;
  return body.subarray(tag.dataStart, e).toString('utf8');
}

function patchDefineSprite(body, tag, found) {
  const spriteId = body.readUInt16LE(tag.dataStart);
  const frameCount = body.readUInt16LE(tag.dataStart + 2);
  const end = tag.dataStart + tag.len;
  let p = tag.dataStart + 4;
  const out = [Buffer.from(body.subarray(tag.dataStart, tag.dataStart + 4))];
  let labelCount = 0;
  let frame = 1;
  while (p < end) {
    const raw = body.readUInt16LE(p);
    const code = raw >> 6;
    let len = raw & 0x3f;
    let headerLen = 2;
    if (len === 0x3f) { len = body.readUInt32LE(p + 2); headerLen = 6; }
    const dataStart = p + headerLen;
    if (code === 43) {
      let e = dataStart;
      while (e < dataStart + len && body[e] !== 0) e++;
      const label = body.subarray(dataStart, e).toString('utf8');
      const next = LABEL_MAP[label];
      if (next) {
        labelCount++;
        found.push({ spriteId, frame, from: label, to: next });
        // 跳过原 NUL，保留其后的可选 NamedAnchor 标志字节（若有）
        const tail = body.subarray(Math.min(e + 1, dataStart + len), dataStart + len);
        const data = Buffer.concat([Buffer.from(next + '\0', 'utf8'), tail]);
        out.push(buildTag(43, data));
        console.log('  sprite ' + spriteId + ' frame ' + frame + ': ' + label + ' -> ' + next);
        p = dataStart + len;
        continue;
      }
    }
    if (code === 1) frame++;
    out.push(Buffer.from(body.subarray(p, dataStart + len)));
    if (code === 0) break;
    p = dataStart + len;
  }
  return { spriteId, frameCount, data: Buffer.concat(out), labelCount };
}

const { sig, version, body } = readSwf(swfPath);
const tags = topTags(body);
const targets = tags.filter((t) => t.code === 39 && spriteIds.has(body.readUInt16LE(t.dataStart)));
if (targets.length !== spriteIds.size) {
  throw new Error('只找到 ' + targets.length + ' 个目标 DefineSprite，期望 ' + spriteIds.size);
}

const found = [];
const newTags = new Map();
for (const t of targets) {
  console.log('打补丁 DefineSprite:');
  const r = patchDefineSprite(body, t, found);
  newTags.set(t, r.data);
  console.log('  sprite ' + r.spriteId + ' frames=' + r.frameCount + ' 命中标签=' + r.labelCount);
}

const expected = ['_attackBegin1', '_attackEnd1', '_attackBegin2', '_attackEnd2'];
for (const t of targets) {
  const sid = body.readUInt16LE(t.dataStart);
  const got = found.filter((f) => f.spriteId === sid).map((f) => f.from);
  const miss = expected.filter((x) => !got.includes(x));
  if (miss.length) throw new Error('sprite ' + sid + ' 缺少标签: ' + miss.join(','));
}

if (!apply) {
  console.log('dry-run：未写盘。加 --apply 才会保存。');
  process.exit(0);
}

const chunks = [];
let cursor = 0;
for (const t of tags) {
  if (!newTags.has(t)) continue;
  chunks.push(body.subarray(cursor, t.tagStart));
  chunks.push(buildTag(39, newTags.get(t)));
  cursor = t.dataStart + t.len;
}
chunks.push(body.subarray(cursor));
const newBody = Buffer.concat(chunks);

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = swfPath + '.bak-skinlabels-' + stamp;
fs.copyFileSync(swfPath, backup);
writeSwf(swfPath, version, newBody);
console.log('已备份: ' + backup);
console.log('已写入: ' + swfPath + ' (' + newBody.length + ' bytes 解压后)');

// 校验
const check = readSwf(swfPath);
let ok = 0;
for (const t of topTags(check.body)) {
  if (t.code !== 39) continue;
  const sid = check.body.readUInt16LE(t.dataStart);
  if (!spriteIds.has(sid)) continue;
  const end = t.dataStart + t.len;
  let p = t.dataStart + 4;
  const labels = [];
  let frame = 1;
  while (p < end) {
    const raw = check.body.readUInt16LE(p);
    const code = raw >> 6;
    let len = raw & 0x3f;
    let headerLen = 2;
    if (len === 0x3f) { len = check.body.readUInt32LE(p + 2); headerLen = 6; }
    if (code === 1) frame++;
    if (code === 43) {
      let e = p + headerLen;
      while (e < p + headerLen + len && check.body[e] !== 0) e++;
      labels.push(frame + ':' + check.body.subarray(p + headerLen, e).toString('utf8'));
    }
    if (code === 0) break;
    p += headerLen + len;
  }
  console.log('校验 sprite ' + sid + ': ' + labels.join(' '));
  ok++;
}
if (ok !== spriteIds.size) throw new Error('回读校验失败');
