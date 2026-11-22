'use strict';
/**
 * 比较两个 SWF 的 ABC 方法体差异，定位某次补丁改了哪些类/方法。
 * 用法: node tools/diff_swf.js --a ../main.swf --b ../main.swf.bak-xxx
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { Abc } = require('./abc-parser.js');

function arg(v) { const i = process.argv.indexOf(v); return i >= 0 ? process.argv[i + 1] : null; }
const aPath = arg('--a'), bPath = arg('--b');
if (!aPath || !bPath) { console.error('用法: --a <swf> --b <swf>'); process.exit(1); }

function loadAbc(file) {
  const input = fs.readFileSync(path.resolve(file));
  const sig = input.toString('ascii', 0, 3);
  const body = sig === 'CWS' ? zlib.inflateSync(input.subarray(8)) : input.subarray(8);
  let p = 0;
  const nbits = (body[0] >> 3) & 0x1f;
  p += Math.ceil((5 + 4 * nbits) / 8) + 4;
  while (p < body.length) {
    const raw = body.readUInt16LE(p);
    const code = raw >> 6; let len = raw & 0x3f; let hl = 2;
    if (len === 0x3f) { len = body.readUInt32LE(p + 2); hl = 6; }
    if (code === 82) {
      let q = p + hl + 4; while (q < p + hl + len && body[q] !== 0) q++;
      return new Abc(Buffer.from(body.subarray(q + 1, p + hl + len)));
    }
    p += hl + len; if (code === 0) break;
  }
  throw new Error('无 DoABC: ' + file);
}

const A = loadAbc(aPath);
const B = loadAbc(bPath);

// 建立 methodIndex -> "Class.method" 和 body hex 的映射
function indexBodies(abc) {
  const map = new Map();
  const bodyByMethod = new Map();
  for (const b of abc.bodies) bodyByMethod.set(b.method, b);
  for (const inst of abc.instances) {
    const cls = abc.mnName(inst.name);
    const klass = abc.classes[abc.instances.indexOf(inst)];
    const all = [].concat(inst.traits, klass ? klass.traits : []);
    for (const t of all) {
      if (t.method === undefined) continue;
      const body = bodyByMethod.get(t.method);
      if (!body) continue;
      const key = cls + '.' + abc.simpleMnName(t.name);
      map.set(key, Buffer.from(body.code).toString('hex'));
    }
  }
  return map;
}

const ma = indexBodies(A);
const mb = indexBodies(B);
const changed = [];
const added = [];
const removed = [];
for (const [k, v] of ma) {
  if (!mb.has(k)) added.push(k);
  else if (mb.get(k) !== v) changed.push(k);
}
for (const k of mb.keys()) if (!ma.has(k)) removed.push(k);

console.log('A = ' + aPath + '  (' + ma.size + ' methods)');
console.log('B = ' + bPath + '  (' + mb.size + ' methods)');
console.log('changed: ' + changed.length + ', added: ' + added.length + ', removed: ' + removed.length);
console.log('--- changed ---');
for (const k of changed) {
  console.log('  ' + k);
}
if (added.length) { console.log('--- added ---'); added.forEach(k => console.log('  ' + k)); }
if (removed.length) { console.log('--- removed ---'); removed.forEach(k => console.log('  ' + k)); }
