'use strict';
/**
 * 把 new_classes.swf 里的 DoABC(2) 追加到目标 main.swf。
 * 用法: node tools/merge_abc.js <main.swf> <classes.swf> <out.swf>
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const mainPath = path.resolve(process.argv[2]);
const clsPath = path.resolve(process.argv[3]);
const outPath = path.resolve(process.argv[4]);

function readSwf(file) {
  const raw = fs.readFileSync(file);
  const sig = raw.toString('ascii', 0, 3);
  if (sig !== 'CWS' && sig !== 'FWS') throw new Error('unsupported sig ' + sig);
  const version = raw[3];
  const body = sig === 'CWS' ? zlib.inflateSync(raw.subarray(8)) : raw.subarray(8);
  return { sig, version, body };
}
function writeSwf(file, version, body) {
  const h = Buffer.alloc(8);
  h.write('CWS', 0, 'ascii');
  h[3] = version;
  h.writeUInt32LE(body.length + 8, 4);
  fs.writeFileSync(file, Buffer.concat([h, zlib.deflateSync(body, { level: 9 })]));
}
function tags(body) {
  let p = 0;
  const nbits = (body[0] >> 3) & 0x1f;
  p += Math.ceil((5 + 4 * nbits) / 8) + 4;
  const out = [];
  while (p < body.length) {
    const start = p;
    const raw = body.readUInt16LE(p);
    const code = raw >> 6;
    let len = raw & 0x3f;
    let hl = 2;
    if (len === 0x3f) { len = body.readUInt32LE(p + 2); hl = 6; }
    out.push({ code, start, dataStart: p + hl, len, hl, end: p + hl + len });
    if (code === 0) break;
    p += hl + len;
  }
  return out;
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

const main = readSwf(mainPath);
const cls = readSwf(clsPath);
const clsTags = tags(cls.body);
const doabc = clsTags.find((t) => t.code === 82);
if (!doabc) throw new Error('classes.swf 没有 DoABC tag');
const payload = cls.body.subarray(doabc.dataStart, doabc.dataStart + doabc.len);
console.log('new ABC payload', payload.length, 'bytes');

const mainTags = tags(main.body);
const endTag = mainTags[mainTags.length - 1];
if (!endTag || endTag.code !== 0) throw new Error('main.swf 找不到 End tag');
const newTag = buildTag(82, payload);
const newBody = Buffer.concat([
  main.body.subarray(0, endTag.start),
  newTag,
  main.body.subarray(endTag.start),
]);
writeSwf(outPath, main.version, newBody);
console.log('written', outPath, 'body', main.body.length, '->', newBody.length);
