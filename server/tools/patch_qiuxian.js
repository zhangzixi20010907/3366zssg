#!/usr/bin/env node
/**
 * 修复客户端「求贤令招募」无反应的问题。
 *
 * 原因：
 *   GeneralZhaomuPanel.sendToHttpNew 里 HTTP_NEW_QIUXIAN_ZHAOMU(10002) 分支是空的；
 *   同时客户端没有 qiuxianResponse。
 *
 * 修复：
 *   1. 把 10002 分支的 jump 目标改成 10003 分支，复用 diankaResponse；
 *   2. 在 Test.qiuxianZhaomu 的响应里：
 *        - delBagItem("proto_3_3", 1) 扣除 1 个求贤令
 *        - data.dianka = 当前点卡（避免 diankaResponse 把点卡清 0）
 *   这样求贤令招募会：扣 1 个求贤令、扣 1000 声望、不花点卡、不消耗招募次数。
 *
 * 用法：
 *   node tools/patch_qiuxian.js --swf ../main.swf
 *   node tools/patch_qiuxian.js --swf ../main.swf --out ../main_fixed.swf
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Abc } = require('./abc-parser');

/* ----------------------------- SWF 读写 ----------------------------- */

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
    if (len === 0x3f) {
      len = body.readUInt32LE(p + 2);
      headerLen = 6;
    }
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
  const tagPrefix = body.subarray(tag.dataStart, tag.dataStart + 4); // DoABC flags
  let q = tag.dataStart + 4;
  while (q < tag.dataEnd && body[q] !== 0) q++;
  const namePart = body.subarray(tag.dataStart + 4, q + 1); // name + NUL
  const newTagData = Buffer.concat([tagPrefix, namePart, newAbc]);
  const newHeader = buildTagHeader(tag.code, newTagData.length);
  const newBody = Buffer.concat([
    body.subarray(0, tag.headerOffset),
    newHeader,
    newTagData,
    body.subarray(tag.dataEnd),
  ]);
  const totalLen = 8 + newBody.length;
  const header = Buffer.alloc(8);
  header.write(parsed.sig, 0, 'ascii');
  header[3] = parsed.version;
  header.writeUInt32LE(totalLen, 4);
  if (parsed.sig === 'CWS') return Buffer.concat([header, zlib.deflateSync(newBody, { level: 9 })]);
  return Buffer.concat([header, newBody]);
}

/* ----------------------------- U30 工具 ----------------------------- */

function decodeU30At(buf, pos) {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (let i = 0; i < 5; i++) {
    if (p >= buf.length) return null;
    const b = buf[p++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: value >>> 0, next: p };
    shift += 7;
  }
  return null;
}

function encodeU30(value) {
  let v = value >>> 0;
  const bytes = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    bytes.push(b);
  } while (v);
  return Buffer.from(bytes);
}

/* ----------------------------- 补丁逻辑 ----------------------------- */

function findMethod(abc, className, methodName) {
  const r = abc.findMethodBody(className, methodName);
  if (!r) throw new Error('找不到方法 ' + className + '.' + methodName);
  return r;
}

/** 从 diankaZhaomu 里找 dianka 属性的 multiname 索引 */
function findDiankaMn(abc, body) {
  const code = body.code;
  for (let p = 0; p < code.length; p++) {
    if (code[p] !== 0x66 && code[p] !== 0x61) continue;
    const d = decodeU30At(code, p + 1);
    if (d && abc.simpleMnName(d.value) === 'dianka') return d.value;
  }
  throw new Error('找不到 dianka 属性的 multiname');
}

/** 从 RoleModel 的 trait 找 delBagItem 的 multiname 索引 */
function findDelBagItemMn(abc) {
  const r = abc.findInstance('RoleModel');
  if (!r) throw new Error('找不到 RoleModel 类');
  for (const t of [].concat(r.instance.traits, r.klass ? r.klass.traits : [])) {
    if (abc.simpleMnName(t.name) === 'delBagItem') return t.name;
  }
  throw new Error('找不到 RoleModel.delBagItem');
}

function patchSendToHttpNew(abc, body) {
  const code = body.code;
  // 反编译 / 字节码分析：0x7a 是 jump，操作数 0x7b..0x7d
  if (code[0x7a] !== 0x10) throw new Error('sendToHttpNew 0x7a 不是 jump，客户端版本不匹配');
  const operand = code.subarray(0x7b, 0x7e);
  if (operand[0] === 0 && operand[1] === 0 && operand[2] === 0) {
    return { already: true, codeStart: body.codeStart };
  }
  // jump 下一条指令是 0x7e，目标也改成 0x7e（即 10003 dianka 分支）
  if (code[0x7e] === undefined) throw new Error('sendToHttpNew 代码长度异常');
  return { already: false, operandPos: body.codeStart + 0x7b };
}

function patchQiuxianResponse(abc, qiuxianBody, diankaZhaomuBody) {
  const code = qiuxianBody.code;
  const codeLen = qiuxianBody.codeLen;
  if (code.subarray(codeLen - 2).toString('hex') !== 'd348') {
    // 已经是修过后的版本？检查是否已有 delBagItem 调用
    if (code.includes(Buffer.from('4ff70602', 'hex'))) {
      return { already: true };
    }
    throw new Error('Test.qiuxianZhaomu 代码尾部不是 d3 48，客户端版本不匹配');
  }

  // 解析原尾部 22 字节（0xea..0xff）
  const tailStart = codeLen - 22;
  let p = tailStart;
  const read = () => {
    const d = decodeU30At(code, p);
    if (!d) throw new Error('尾部 U30 解析失败');
    p = d.next;
    return d.value;
  };
  if (code[p++] !== 0xd3) throw new Error('尾部 getlocal3 缺失');
  if (code[p++] !== 0x66) throw new Error('尾部 getproperty data 缺失');
  const dataMn = read();
  if (code[p++] !== 0x60) throw new Error('尾部 getlex RoleModel 缺失');
  const roleModelMn = read();
  if (code[p++] !== 0x46) throw new Error('尾部 callproperty getInstance 缺失');
  const getInstanceMn = read();
  if (code[p++] !== 0x00) throw new Error('尾部 getInstance argc 异常');
  if (code[p++] !== 0x2c) throw new Error('尾部 pushstring 缺失');
  const protoStr = read();
  if (code[p++] !== 0x46) throw new Error('尾部 callproperty findBagItemID 缺失');
  read(); // findBagItemID multiname
  if (code[p++] !== 0x01) throw new Error('尾部 findBagItemID argc 异常');
  if (code[p++] !== 0x61) throw new Error('尾部 setproperty itemID 缺失');
  read(); // itemID multiname
  if (code[p++] !== 0xd3 || code[p++] !== 0x48) throw new Error('尾部 return 异常');
  if (p !== codeLen) throw new Error('尾部长度异常');

  const delBagItemMn = findDelBagItemMn(abc);
  const diankaMn = findDiankaMn(abc, diankaZhaomuBody);

  // 新尾部：
  //   RoleModel.getInstance().delBagItem("proto_3_3", 1)
  //   data.dianka = RoleModel.getInstance().dianka
  //   return response
  const newTail = Buffer.concat([
    Buffer.from([0x60]), encodeU30(roleModelMn),                    // getlex RoleModel
    Buffer.from([0x46]), encodeU30(getInstanceMn), Buffer.from([0x00]), // getInstance()
    Buffer.from([0x2c]), encodeU30(protoStr),                      // "proto_3_3"
    Buffer.from([0x24, 0x01]),                                     // pushbyte 1
    Buffer.from([0x4f]), encodeU30(delBagItemMn), Buffer.from([0x02]), // delBagItem(code,1)
    Buffer.from([0xd3, 0x66]), encodeU30(dataMn),                  // response.data
    Buffer.from([0x60]), encodeU30(roleModelMn),                    // getlex RoleModel
    Buffer.from([0x46]), encodeU30(getInstanceMn), Buffer.from([0x00]), // getInstance()
    Buffer.from([0x66]), encodeU30(diankaMn),                      // getproperty dianka
    Buffer.from([0x61]), encodeU30(diankaMn),                      // setproperty dianka
    Buffer.from([0xd3, 0x48]),                                     // return response
  ]);

  // 原尾部共 22 字节（从 getlocal3 到 returnvalue），整体替换成 newTail
  const newCodeLen = codeLen - 22 + newTail.length;
  const oldLenBuf = Buffer.from(code.subarray(0, codeLen));
  const newLenBuf = encodeU30(newCodeLen);
  return {
    already: false,
    tailStart,
    newTail,
    newCodeLen,
    newLenBuf,
    oldLenBuf,
    dataMn, roleModelMn, getInstanceMn, protoStr, delBagItemMn, diankaMn,
  };
}

function main() {
  const args = process.argv.slice(2);
  let swf = '../main.swf';
  let outArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--swf') swf = args[++i];
    else if (args[i] === '--out') outArg = args[++i];
    else if (args[i] === '-h' || args[i] === '--help') { console.log('用法: node tools/patch_qiuxian.js --swf ../main.swf [--out 输出文件]'); process.exit(0); }
    else throw new Error('未知参数: ' + args[i]);
  }
  const swfPath = path.resolve(swf);
  const outPath = outArg ? path.resolve(outArg) : swfPath;

  const parsed = parseSwf(swfPath);
  const tag = findAbcTag(parsed.body);
  const abcInfo = extractAbc(parsed.body, tag);
  const abc = new Abc(abcInfo.bytes);

  const send = findMethod(abc, 'GeneralZhaomuPanel', 'sendToHttpNew');
  const qiuxian = findMethod(abc, 'Test', 'qiuxianZhaomu');
  const diankaZhaomu = findMethod(abc, 'Test', 'diankaZhaomu');

  console.log('[1/3] sendToHttpNew codeStart=' + send.body.codeStart + ' codeLen=' + send.body.codeLen);
  console.log('[2/3] Test.qiuxianZhaomu codeStart=' + qiuxian.body.codeStart + ' codeLen=' + qiuxian.body.codeLen);

  const sendPatch = patchSendToHttpNew(abc, send.body);
  const responsePatch = patchQiuxianResponse(abc, qiuxian.body, diankaZhaomu.body);

  if (sendPatch.already && responsePatch.already) {
    console.log('补丁已存在，无需修改。');
    return;
  }

  // 1) 先改 sendToHttpNew 的 jump 操作数（等长，原地修改）
  let work = Buffer.from(abcInfo.bytes);
  if (!sendPatch.already) {
    work[sendPatch.operandPos] = 0;
    work[sendPatch.operandPos + 1] = 0;
    work[sendPatch.operandPos + 2] = 0;
  }

  // 2) 再替换 Test.qiuxianZhaomu 尾部（长度变化）
  if (!responsePatch.already) {
    const qstart = qiuxian.body.codeStart;
    const qlenPos = qiuxian.body.codeLenPos;
    const tailStart = responsePatch.tailStart;
    const codeEnd = qiuxian.body.codeEnd;
    const before = work.subarray(0, qlenPos);
    const oldLen = work.subarray(qlenPos, qstart);
    const codeBeforeTail = work.subarray(qstart, qstart + tailStart);
    const afterCode = work.subarray(codeEnd);
    const newLenBuf = responsePatch.newLenBuf;
    if (newLenBuf.length !== oldLen.length) {
      // 极少数情况下 U30 长度变化，直接按新长度拼
    }
    work = Buffer.concat([before, newLenBuf, codeBeforeTail, responsePatch.newTail, afterCode]);
  }

  const outSwf = rebuildSwf(parsed, tag, work);

  if (outPath === swfPath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = swfPath + '.bak-qiuxian-' + stamp;
    fs.copyFileSync(swfPath, backup);
    console.log('[3/3] 已备份原文件: ' + backup);
  }
  fs.writeFileSync(outPath, outSwf);

  // ---- 验证 ----
  const check = parseSwf(outPath);
  const checkTag = findAbcTag(check.body);
  const checkAbc = new Abc(extractAbc(check.body, checkTag).bytes);
  const s2 = findMethod(checkAbc, 'GeneralZhaomuPanel', 'sendToHttpNew');
  const q2 = findMethod(checkAbc, 'Test', 'qiuxianZhaomu');
  const jumpOk = s2.body.code[0x7a] === 0x10 && s2.body.code[0x7b] === 0 && s2.body.code[0x7c] === 0 && s2.body.code[0x7d] === 0;
  const tail = q2.body.code.subarray(q2.body.codeLen - 33);
  const tailHex = tail.toString('hex');
  const hasDelBag = tailHex.includes('4f' + encodeU30(responsePatch.delBagItemMn).toString('hex') + '02');
  const hasDianka = tailHex.includes('66' + encodeU30(responsePatch.diankaMn).toString('hex') + '61' + encodeU30(responsePatch.diankaMn).toString('hex'));
  console.log('');
  console.log('验证:');
  console.log('  10002 -> diankaResponse 分支: ' + (jumpOk ? 'OK' : 'FAIL'));
  console.log('  qiuxian 扣求贤令: ' + (hasDelBag ? 'OK' : 'FAIL'));
  console.log('  qiuxian 回填点卡: ' + (hasDianka ? 'OK' : 'FAIL'));
  console.log('  qiuxian codeLen: ' + q2.body.codeLen + ' (maxStack=' + q2.body.maxStack + ', maxLocal=' + q2.body.maxLocal + ')');
  console.log('  输出大小: ' + outSwf.length + ' 字节');
  if (!jumpOk || !hasDelBag || !hasDianka) process.exit(2);
}

try {
  main();
} catch (e) {
  console.error('[error] ' + e.message);
  process.exit(1);
}
