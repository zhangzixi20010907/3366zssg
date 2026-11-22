#!/usr/bin/env node
/**
 * 客户端充值补丁工具
 *
 * 做的事情：
 *   1. 把 Config.CHONGZHI 从 4399 的 pay.php 改成自己的充值网站地址；
 *   2. 把 head=10009（游戏内领取点卡）加入 AESController.isServerHead，
 *      让“充值后点击商城领取点卡”真正请求服务端，而不是走本地模拟。
 *
 * 用法：
 *   node tools/patch_client_pay.js --swf ../main.swf
 *   node tools/patch_client_pay.js --swf ../main.swf --url http://1.2.3.4:8080/pay
 *   node tools/patch_client_pay.js --swf ../main.swf --out ../main_pay.swf
 *
 * 不指定 --url 时，会读取 server/pay-config.json 的 baseUrl + "/pay"。
 * 默认原地修改，并在第一次修改前备份为 main.swf.bak-pay-时间戳。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OLD_URL = 'http://my.4399.com/pay.php?ac=exchange&union=176';
const UNPATCHED_PATTERN = Buffer.from('258f4e25904e25a94625aa4625ab465605', 'hex');
const PATCHED_PATTERN = Buffer.from('258f4e25904e25a94625aa4625ab4625994e5606', 'hex');
const HEAD_PUSH_10009 = Buffer.from('25994e', 'hex');
const NEWARRAY_6 = Buffer.from('5606', 'hex');

function usage(code) {
  console.log('用法: node tools/patch_client_pay.js --swf <main.swf> [--url <充值网址>] [--out <输出文件>] [--no-backup]');
  process.exit(code || 0);
}

function parseArgs(argv) {
  const out = { backup: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--swf') out.swf = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--no-backup') out.backup = false;
    else if (a === '-h' || a === '--help') usage(0);
    else throw new Error('未知参数: ' + a);
  }
  if (!out.swf) usage(1);
  return out;
}

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

function findU30Prefix(buf, strStart, expectedLen) {
  for (let start = strStart - 1; start >= Math.max(0, strStart - 5); start--) {
    const d = decodeU30At(buf, start);
    if (d && d.next === strStart && d.value === expectedLen) {
      return { start, len: strStart - start };
    }
  }
  return null;
}

function parseSwf(file) {
  const input = fs.readFileSync(file);
  if (input.length < 8) throw new Error('不是有效的 SWF 文件');
  const sig = input.toString('ascii', 0, 3);
  const version = input[3];
  const declaredLen = input.readUInt32LE(4);
  let body;
  if (sig === 'CWS') body = zlib.inflateSync(input.subarray(8));
  else if (sig === 'FWS') body = input.subarray(8);
  else if (sig === 'ZWS') throw new Error('暂不支持 LZMA 压缩的 ZWS，请先转成 CWS/FWS');
  else throw new Error('未知 SWF 签名: ' + sig);

  if (declaredLen !== 8 + body.length) {
    console.warn('[warn] SWF 头部声明长度与解压长度不一致: ' + declaredLen + ' / ' + (8 + body.length));
  }
  return { input, sig, version, body };
}

function parseTags(body) {
  let p = 0;
  const nbits = (body[0] >> 3) & 0x1f;
  p += Math.ceil((5 + 4 * nbits) / 8) + 4;
  const tags = [];
  while (p < body.length) {
    if (p + 2 > body.length) break;
    const raw = body.readUInt16LE(p);
    const code = raw >> 6;
    let len = raw & 0x3f;
    let headerLen = 2;
    if (len === 0x3f) {
      if (p + 6 > body.length) throw new Error('SWF tag 长度字段损坏');
      len = body.readUInt32LE(p + 2);
      headerLen = 6;
    }
    tags.push({
      code,
      len,
      headerOffset: p,
      headerLen,
      dataStart: p + headerLen,
      dataEnd: p + headerLen + len,
    });
    p += headerLen + len;
    if (code === 0) break;
  }
  return tags;
}

function findAbcTag(body) {
  const tags = parseTags(body);
  const abcs = tags.filter((t) => t.code === 82);
  if (abcs.length !== 1) {
    throw new Error('期望 1 个 DoABC tag，实际找到 ' + abcs.length + ' 个');
  }
  return abcs[0];
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

/** 在 ABC 里找到包含指定 pattern 的方法体，返回代码起点和 codeLen 字段位置 */
function findMethodBody(abc, patternOffset, patternLen) {
  // 方法体代码以 getlocal0(0xd0) + pushscope(0x30) 开头
  for (let codeStart = Math.min(patternOffset, abc.length - 2); codeStart >= patternOffset - 160 && codeStart >= 2; codeStart--) {
    if (abc[codeStart] !== 0xd0 || abc[codeStart + 1] !== 0x30) continue;
    for (let lenStart = codeStart - 5; lenStart <= codeStart - 1; lenStart++) {
      if (lenStart < 0) continue;
      const d = decodeU30At(abc, lenStart);
      if (!d || d.next !== codeStart) continue;
      const codeEnd = codeStart + d.value;
      if (patternOffset >= codeStart && patternOffset + patternLen <= codeEnd && d.value < 100000) {
        return { codeStart, codeLenPos: lenStart, codeLen: d.value };
      }
    }
  }
  return null;
}

/** 定位方法体头部 6 个 U30 字段：method, maxStack, maxLocal, initScope, maxScope, codeLen */
function findBodyHeader(abc, body) {
  for (let start = Math.max(0, body.codeLenPos - 20); start <= body.codeLenPos; start++) {
    let p = start;
    const positions = [];
    const fields = [];
    let ok = true;
    for (let i = 0; i < 6; i++) {
      positions.push(p);
      const d = decodeU30At(abc, p);
      if (!d) { ok = false; break; }
      fields.push(d.value);
      p = d.next;
    }
    if (!ok || p !== body.codeStart) continue;
    if (fields[5] !== body.codeLen) continue;
    return {
      start,
      maxStackPos: positions[1],
      maxLocalPos: positions[2],
      maxStack: fields[1],
      maxLocal: fields[2],
      initScope: fields[3],
      maxScope: fields[4],
      codeLen: fields[5],
    };
  }
  return null;
}

/** 确保 maxStack 至少为 required（新增数组元素后必须同步放大，否则 AVM2 会闪退） */
function ensureMaxStack(abc, patternOffset, patternLen, required) {
  const body = findMethodBody(abc, patternOffset, patternLen);
  if (!body) throw new Error('无法定位 isServerHead 方法体');
  const header = findBodyHeader(abc, body);
  if (!header) throw new Error('无法定位 isServerHead 方法体头部');
  if (header.maxStack >= required) {
    return { abc, delta: 0, maxStack: header.maxStack };
  }
  const oldBuf = abc.subarray(header.maxStackPos, header.maxLocalPos);
  const newBuf = encodeU30(required);
  let next;
  if (newBuf.length === oldBuf.length) {
    next = Buffer.from(abc);
    newBuf.copy(next, header.maxStackPos);
  } else {
    next = Buffer.concat([
      abc.subarray(0, header.maxStackPos),
      newBuf,
      abc.subarray(header.maxLocalPos),
    ]);
  }
  return { abc: next, delta: next.length - abc.length, maxStack: required };
}

function replaceUrl(abc, newUrl) {
  const oldBuf = Buffer.from(OLD_URL, 'ascii');
  const newBuf = Buffer.from(newUrl, 'ascii');
  const idx = abc.indexOf(oldBuf);
  if (idx === -1) {
    if (abc.indexOf(newBuf) !== -1) return { abc, delta: 0, already: true };
    throw new Error('ABC 中找不到 Config.CHONGZHI 原地址，客户端版本可能不匹配');
  }
  const prefix = findU30Prefix(abc, idx, oldBuf.length);
  if (!prefix) throw new Error('找不到 URL 字符串的 U30 长度前缀');
  const newPrefix = encodeU30(newBuf.length);
  const before = abc.subarray(0, prefix.start);
  const after = abc.subarray(idx + oldBuf.length);
  const next = Buffer.concat([before, newPrefix, newBuf, after]);
  return { abc: next, delta: next.length - abc.length, already: false };
}

function insertHead10009(abc) {
  let offset = abc.indexOf(UNPATCHED_PATTERN);
  let already = false;
  if (offset === -1) {
    offset = abc.indexOf(PATCHED_PATTERN);
    if (offset === -1) throw new Error('找不到 isServerHead 的常量数组，客户端版本可能不匹配');
    already = true;
  }
  const pattern = already ? PATCHED_PATTERN : UNPATCHED_PATTERN;

  // 数组从 5 个元素变 6 个，maxStack 至少 6；
  // 老版本补丁漏了这一步，会导致登录/注册闪退。
  const stackResult = ensureMaxStack(abc, offset, pattern.length, 6);
  let work = stackResult.abc;
  let delta = stackResult.delta;

  if (already) {
    return { abc: work, delta, already: true, maxStack: stackResult.maxStack };
  }

  let patOff = work.indexOf(UNPATCHED_PATTERN);
  if (patOff === -1) throw new Error('调整 maxStack 后找不到数组');
  const body = findMethodBody(work, patOff, UNPATCHED_PATTERN.length);
  if (!body) throw new Error('找到了数组但无法定位方法体，拒绝修改');
  if (body.codeLen + 3 > 0xffff) throw new Error('方法体过大，异常');

  const oldLenBuf = work.subarray(body.codeLenPos, body.codeStart);
  const newLenBuf = encodeU30(body.codeLen + 3);
  if (newLenBuf.length !== oldLenBuf.length) {
    work = Buffer.concat([
      work.subarray(0, body.codeLenPos),
      newLenBuf,
      work.subarray(body.codeStart),
    ]);
    delta += newLenBuf.length - oldLenBuf.length;
  } else {
    work = Buffer.from(work);
    newLenBuf.copy(work, body.codeLenPos);
  }

  patOff = work.indexOf(UNPATCHED_PATTERN);
  if (patOff === -1) throw new Error('修改 codeLen 后找不到数组');

  const replacement = Buffer.concat([
    UNPATCHED_PATTERN.subarray(0, 15),
    HEAD_PUSH_10009,
    NEWARRAY_6,
  ]);

  const next = Buffer.concat([
    work.subarray(0, patOff),
    replacement,
    work.subarray(patOff + UNPATCHED_PATTERN.length),
  ]);
  return { abc: next, delta: next.length - abc.length, already: false, maxStack: stackResult.maxStack };
}

function rebuildSwf(parsed, tag, newAbc) {
  const body = parsed.body;
  const prefix = body.subarray(tag.dataStart, tag.dataStart + 4);
  // DoABC 的 name 是 C 字符串，放在 flags 之后
  let q = tag.dataStart + 4;
  while (q < tag.dataEnd && body[q] !== 0) q++;
  if (q >= tag.dataEnd) throw new Error('DoABC name 字段损坏');
  const abcPrefix = body.subarray(tag.dataStart, q + 1);
  const newTagData = Buffer.concat([prefix, Buffer.from(abcPrefix.subarray(4)), newAbc]);
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

  if (parsed.sig === 'CWS') {
    return Buffer.concat([header, zlib.deflateSync(newBody, { level: 9 })]);
  }
  return Buffer.concat([header, newBody]);
}

function defaultUrlFromConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pay-config.json'), 'utf8'));
    if (cfg.baseUrl && cfg.baseUrl !== 'auto') {
      return String(cfg.baseUrl).replace(/\/+$/, '') + '/pay';
    }
  } catch (e) {
    return null;
  }
  return null;
}

function validateUrl(url) {
  if (!/^https?:\/\/[^\s"'<>]+$/.test(url)) {
    throw new Error('充值网址必须以 http:// 或 https:// 开头，且不能包含空格/引号/尖括号');
  }
  if (Buffer.byteLength(url, 'ascii') > 240) throw new Error('充值网址过长（建议 < 240 字节）');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const swfPath = path.resolve(args.swf);
  const newUrl = args.url || defaultUrlFromConfig();
  if (!newUrl) throw new Error('未指定 --url，且 pay-config.json 的 baseUrl 不是可用的 HTTP 地址');
  validateUrl(newUrl);

  const outPath = args.out ? path.resolve(args.out) : swfPath;
  const parsed = parseSwf(swfPath);
  const tag = findAbcTag(parsed.body);

  let abc = parsed.body.subarray(tag.dataStart, tag.dataEnd);
  // 去掉 DoABC 的 flags + name，只保留真正的 ABC 数据
  let q = tag.dataStart + 4;
  while (q < tag.dataEnd && parsed.body[q] !== 0) q++;
  const abcPrefixLen = q + 1 - tag.dataStart;
  abc = Buffer.from(parsed.body.subarray(tag.dataStart + abcPrefixLen, tag.dataEnd));

  console.log('[1/3] 原充值地址: ' + OLD_URL);
  console.log('[2/3] 新充值地址: ' + newUrl);
  const urlResult = replaceUrl(abc, newUrl);
  abc = urlResult.abc;
  console.log('      URL 替换: ' + (urlResult.already ? '已是最新，跳过' : '完成，ABC 偏移 ' + (urlResult.delta >= 0 ? '+' : '') + urlResult.delta));

  const headResult = insertHead10009(abc);
  abc = headResult.abc;
  console.log('      head=10009 服务端转发: ' + (headResult.already
    ? '补丁已存在，已确认 maxStack=' + headResult.maxStack
    : '完成，maxStack=' + headResult.maxStack + '，ABC 偏移 +' + headResult.delta));

  const out = rebuildSwf(parsed, tag, abc);

  if (outPath === swfPath && args.backup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = swfPath + '.bak-pay-' + stamp;
    fs.copyFileSync(swfPath, backup);
    console.log('[3/3] 已备份原文件: ' + backup);
  } else {
    console.log('[3/3] 输出文件: ' + outPath);
  }
  fs.writeFileSync(outPath, out);

  // ---- 验证 ----
  const check = parseSwf(outPath);
  const checkTag = findAbcTag(check.body);
  let cq = checkTag.dataStart + 4;
  while (cq < checkTag.dataEnd && check.body[cq] !== 0) cq++;
  const checkAbc = check.body.subarray(cq + 1, checkTag.dataEnd);
  const urlOk = checkAbc.indexOf(Buffer.from(newUrl, 'ascii')) !== -1;
  const oldGone = checkAbc.indexOf(Buffer.from(OLD_URL, 'ascii')) === -1;
  const checkPatOff = checkAbc.indexOf(PATCHED_PATTERN);
  const headOk = checkPatOff !== -1;
  const checkBody = headOk ? findMethodBody(checkAbc, checkPatOff, PATCHED_PATTERN.length) : null;
  const checkHeader = checkBody ? findBodyHeader(checkAbc, checkBody) : null;
  const maxStackOk = Boolean(checkHeader && checkHeader.maxStack >= 6);
  console.log('');
  console.log('验证:');
  console.log('  新充值地址存在: ' + (urlOk ? 'OK' : 'FAIL'));
  console.log('  旧充值地址移除: ' + (oldGone ? 'OK' : 'FAIL'));
  console.log('  head=10009 转发补丁: ' + (headOk ? 'OK' : 'FAIL'));
  console.log('  isServerHead maxStack >= 6: ' + (maxStackOk ? 'OK (' + checkHeader.maxStack + ')' : 'FAIL'));
  console.log('  输出大小: ' + out.length + ' 字节');
  if (!urlOk || !oldGone || !headOk || !maxStackOk) process.exit(2);
}

try {
  main();
} catch (e) {
  console.error('[error] ' + e.message);
  process.exit(1);
}
