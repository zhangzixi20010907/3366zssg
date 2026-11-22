#!/usr/bin/env node
/**
 * 修复「创建角色第一次点继续必超时，第二次才成功」。
 *
 * 原因：
 *   createRoleHandler 里请求带 mask=true。如果此时 AESController 的
 *   _maskCode/_maskDomain 还没初始化，createMask() 会直接返回，_mask 为 null；
 *   但 send() 仍会设置 _maskRelative=stamp。服务端响应回来时，
 *   onURLLoaderCompleteHandler 执行 removeChild(_mask)（_mask 为 null）抛异常，
 *   回调没有执行，8 秒后弹出“创建角色请求超时”。第二次请求时遮罩已初始化，所以正常。
 *
 * 修复：
 *   把 createRoleHandler 两处 _loc4_.mask = true 改成 false。
 *   创建角色请求不再走遮罩，响应能正常回调；服务端本来就会创建角色，行为不变。
 *
 * 用法：
 *   node tools/patch_create_role_mask.js --swf ../main.swf
 *   node tools/patch_create_role_mask.js --swf ../main.swf --out ../main_fixed.swf
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Abc } = require('./abc-parser');

function parseSwf(file) {
  const input = fs.readFileSync(file);
  const sig = input.toString('ascii', 0, 3);
  const version = input[3];
  let body;
  if (sig === 'CWS') body = zlib.inflateSync(input.subarray(8));
  else if (sig === 'FWS') body = input.subarray(8);
  else throw new Error('不支持的 SWF 签名: ' + sig);
  return { input, sig, version, body };
}

function parseTags(body) {
  let p = 0;
  const nbits = (body[0] >> 3) & 0x1f;
  p += Math.ceil((5 + 4 * nbits) / 8) + 4;
  const tags = [];
  while (p < body.length) {
    const raw = body.readUInt16LE(p);
    const code = raw >> 6;
    let len = raw & 0x3f;
    let headerLen = 2;
    if (len === 0x3f) { len = body.readUInt32LE(p + 2); headerLen = 6; }
    tags.push({ code, len, headerOffset: p, headerLen, dataStart: p + headerLen, dataEnd: p + headerLen + len });
    p += headerLen + len;
    if (code === 0) break;
  }
  return tags;
}

function findAbcTag(body) {
  const abcs = parseTags(body).filter((t) => t.code === 82);
  if (abcs.length !== 1) throw new Error('期望 1 个 DoABC tag，实际 ' + abcs.length);
  return abcs[0];
}

function extractAbc(body, tag) {
  let q = tag.dataStart + 4;
  while (q < tag.dataEnd && body[q] !== 0) q++;
  return { dataStart: q + 1, bytes: body.subarray(q + 1, tag.dataEnd) };
}

function buildTagHeader(code, dataLen) {
  if (dataLen <= 0x3f) {
    const h = Buffer.alloc(2);
    h.writeUInt16LE(((code & 0x3ff) << 6) | dataLen, 0);
    return h;
  }
  const h = Buffer.alloc(6);
  h.writeUInt16LE(((code & 0x3ff) << 6) | 0x3f, 0);
  h.writeUInt32LE(dataLen, 2);
  return h;
}

function rebuildSwf(parsed, tag, newAbc) {
  const body = parsed.body;
  const flags = body.subarray(tag.dataStart, tag.dataStart + 4);
  let q = tag.dataStart + 4;
  while (q < tag.dataEnd && body[q] !== 0) q++;
  const name = body.subarray(tag.dataStart + 4, q + 1);
  const newTagData = Buffer.concat([flags, name, newAbc]);
  const newHeader = buildTagHeader(tag.code, newTagData.length);
  const newBody = Buffer.concat([
    body.subarray(0, tag.headerOffset),
    newHeader,
    newTagData,
    body.subarray(tag.dataEnd),
  ]);
  const header = Buffer.alloc(8);
  header.write(parsed.sig, 0, 'ascii');
  header[3] = parsed.version;
  header.writeUInt32LE(8 + newBody.length, 4);
  if (parsed.sig === 'CWS') return Buffer.concat([header, zlib.deflateSync(newBody, { level: 9 })]);
  return Buffer.concat([header, newBody]);
}

function main() {
  const args = process.argv.slice(2);
  let swf = '../main.swf';
  let outArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--swf') swf = args[++i];
    else if (args[i] === '--out') outArg = args[++i];
    else if (args[i] === '-h' || args[i] === '--help') { console.log('用法: node tools/patch_create_role_mask.js --swf ../main.swf [--out 输出文件]'); process.exit(0); }
    else throw new Error('未知参数: ' + args[i]);
  }
  const swfPath = path.resolve(swf);
  const outPath = outArg ? path.resolve(outArg) : swfPath;

  const parsed = parseSwf(swfPath);
  const tag = findAbcTag(parsed.body);
  const abcInfo = extractAbc(parsed.body, tag);
  const abc = new Abc(abcInfo.bytes);
  const r = abc.findMethodBody('Sanguo4399', 'createRoleHandler');
  if (!r) throw new Error('找不到 Sanguo4399.createRoleHandler');
  const body = r.body;
  const code = body.code;

  // 反编译偏移：两个分支的 mask=true 分别在 0x107 和 0x19f 的 pushtrue
  const offsets = [0x107, 0x19f];
  const work = Buffer.from(abcInfo.bytes);
  let changed = 0;
  for (const off of offsets) {
    const pos = body.codeStart + off;
    if (work[pos] === 0x26) {
      work[pos] = 0x27; // pushtrue -> pushfalse
      changed++;
    } else if (work[pos] === 0x27) {
      // 已打过
    } else {
      throw new Error('偏移 0x' + off.toString(16) + ' 不是 pushtrue（实际 0x' + work[pos].toString(16) + '），客户端版本不匹配');
    }
  }

  console.log('[1/2] createRoleHandler codeStart=' + body.codeStart + ' codeLen=' + body.codeLen);
  if (!changed) {
    console.log('补丁已存在，无需修改。');
    return;
  }

  const outSwf = rebuildSwf(parsed, tag, work);
  if (outPath === swfPath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = swfPath + '.bak-createrole-' + stamp;
    fs.copyFileSync(swfPath, backup);
    console.log('[2/2] 已备份原文件: ' + backup);
  }
  fs.writeFileSync(outPath, outSwf);

  // 验证
  const check = parseSwf(outPath);
  const checkTag = findAbcTag(check.body);
  const checkAbc = new Abc(extractAbc(check.body, checkTag).bytes);
  const checkBody = checkAbc.findMethodBody('Sanguo4399', 'createRoleHandler').body;
  const ok1 = checkBody.code[0x107] === 0x27;
  const ok2 = checkBody.code[0x19f] === 0x27;
  console.log('验证:');
  console.log('  分支1 mask=false: ' + (ok1 ? 'OK' : 'FAIL'));
  console.log('  分支2 mask=false: ' + (ok2 ? 'OK' : 'FAIL'));
  console.log('  输出大小: ' + outSwf.length + ' 字节');
  if (!ok1 || !ok2) process.exit(2);
}

try { main(); } catch (e) { console.error('[error] ' + e.message); process.exit(1); }
