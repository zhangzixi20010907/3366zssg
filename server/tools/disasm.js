'use strict';
/**
 * AVM2 ABC 方法体反汇编器（只读，用于分析客户端逻辑）。
 * 用法: node tools/disasm.js --swf ../main.swf --class game::P2PFight --method onSoldierDeadCompleteHandler
 *       node tools/disasm.js --swf ../main.swf --class game::P2PFight           (列出全部方法)
 *       node tools/disasm.js --swf ../main.swf --find p2pFightResult            (按字符串/常量定位方法)
 */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { Abc } = require('./abc-parser.js');

// ---- 参数 ----
const argv = process.argv.slice(2);
function arg(v) { const i = argv.indexOf(v); return i >= 0 ? argv[i + 1] : null; }
const swfPath = arg('--swf');
const className = arg('--class');
const methodName = arg('--method');
const findStr = arg('--find');
const dumpAll = argv.includes('--all');

if (!swfPath) { console.error('缺少 --swf'); process.exit(1); }

// ---- 读 SWF 拿 ABC ----
const input = fs.readFileSync(path.resolve(swfPath));
const sig = input.toString('ascii', 0, 3);
let body = sig === 'CWS' ? zlib.inflateSync(input.subarray(8)) : input.subarray(8);
let p = 0;
const nbits = (body[0] >> 3) & 0x1f;
p += Math.ceil((5 + 4 * nbits) / 8) + 4;
let abcBuf = null;
while (p < body.length) {
  const raw = body.readUInt16LE(p);
  const code = raw >> 6; let len = raw & 0x3f; let hl = 2;
  if (len === 0x3f) { len = body.readUInt32LE(p + 2); hl = 6; }
  if (code === 82) {
    let q = p + hl + 4; while (q < p + hl + len && body[q] !== 0) q++;
    abcBuf = body.subarray(q + 1, p + hl + len); break;
  }
  p += hl + len; if (code === 0) break;
}
if (!abcBuf) { console.error('无 DoABC tag'); process.exit(1); }
const abc = new Abc(Buffer.from(abcBuf));

// ---- 操作码表 ----
const OP = {
  0x01: 'bkpt', 0x02: 'nop', 0x03: 'throw',
  0x04: 'getsuper', 0x05: 'setsuper', 0x06: 'dxns', 0x07: 'dxnslate', 0x08: 'kill',
  0x09: 'label', 0x0c: 'ifnlt', 0x0d: 'ifnle', 0x0e: 'ifngt', 0x0f: 'ifnge',
  0x10: 'jump', 0x11: 'iftrue', 0x12: 'iffalse', 0x13: 'ifeq', 0x14: 'ifne',
  0x15: 'iflt', 0x16: 'ifle', 0x17: 'ifgt', 0x18: 'ifge',
  0x19: 'ifstricteq', 0x1a: 'ifstrictne',
  0x1c: 'lookupswitch',
  0x20: 'pushnull', 0x21: 'pushundefined', 0x22: 'nextname', 0x23: 'hasnext',
  0x24: 'pushbyte', 0x25: 'pushshort', 0x26: 'pushtrue', 0x27: 'pushfalse',
  0x28: 'pushnan', 0x29: 'pop', 0x2a: 'dup', 0x2b: 'swap',
  0x2c: 'pushstring', 0x2d: 'pushint', 0x2e: 'pushuint', 0x2f: 'pushdouble',
  0x30: 'pushscope', 0x31: 'pushnamespace', 0x32: 'hasnext2',
  0x3c: 'pushfloat', 0x3d: 'pushfloat4',
  0x40: 'newfunction', 0x41: 'call', 0x42: 'construct', 0x43: 'callmethod',
  0x44: 'callstatic', 0x45: 'callsuper', 0x46: 'callproperty', 0x47: 'returnvoid',
  0x48: 'returnvalue', 0x49: 'constructsuper', 0x4a: 'constructprop',
  0x4c: 'callproplex', 0x4e: 'callsupervoid', 0x4f: 'callpropvoid',
  0x50: 'sxi1', 0x51: 'sxi8', 0x52: 'sxi16',
  0x53: 'applytype',
  0x55: 'newobject', 0x56: 'newarray', 0x57: 'newactivation', 0x58: 'newclass',
  0x59: 'getdescendants', 0x5a: 'newcatch',
  0x5d: 'findpropstrict', 0x5e: 'findproperty',
  0x60: 'getlex', 0x61: 'setproperty', 0x62: 'getlocal', 0x63: 'setlocal',
  0x64: 'getglobalscope', 0x65: 'getscopeobject', 0x66: 'getproperty',
  0x67: 'initproperty', 0x68: 'deleteproperty',
  0x6a: 'getslot', 0x6b: 'setslot', 0x6c: 'getglobalslot', 0x6d: 'setglobalslot',
  0x6e: 'convert_s', 0x6f: 'esc_xelem', 0x70: 'esc_xattr',
  0x71: 'convert_i', 0x72: 'convert_u', 0x73: 'convert_d', 0x74: 'convert_b',
  0x75: 'convert_o', 0x76: 'checkfilter',
  0x80: 'coerce', 0x81: 'coerce_b', 0x82: 'coerce_a', 0x83: 'coerce_i',
  0x84: 'coerce_d', 0x85: 'coerce_s', 0x86: 'astype', 0x87: 'astypelate',
  0x88: 'coerce_u', 0x89: 'coerce_o',
  0x90: 'negate', 0x91: 'increment', 0x92: 'inclocal', 0x93: 'decrement',
  0x94: 'declocal', 0x95: 'typeof', 0x96: 'not', 0x97: 'bitnot',
  0xa0: 'add', 0xa1: 'subtract', 0xa2: 'multiply', 0xa3: 'divide',
  0xa4: 'modulo', 0xa5: 'lshift', 0xa6: 'rshift', 0xa7: 'urshift',
  0xa8: 'bitand', 0xa9: 'bitor', 0xaa: 'bitxor',
  0xab: 'equals', 0xac: 'strictequals', 0xad: 'lessthan', 0xae: 'lessequals',
  0xaf: 'greaterthan', 0xb0: 'greaterequals', 0xb1: 'instanceof',
  0xb2: 'istype', 0xb3: 'istypelate', 0xb4: 'in',
  0xc0: 'increment_i', 0xc1: 'decrement_i', 0xc2: 'inclocal_i', 0xc3: 'declocal_i',
  0xc4: 'negate_i', 0xc5: 'add_i', 0xc6: 'subtract_i', 0xc7: 'multiply_i',
  0xd0: 'getlocal0', 0xd1: 'getlocal1', 0xd2: 'getlocal2', 0xd3: 'getlocal3',
  0xd4: 'setlocal0', 0xd5: 'setlocal1', 0xd6: 'setlocal2', 0xd7: 'setlocal3',
  0xef: 'debug', 0xf0: 'debugline', 0xf1: 'debugfile', 0xf2: 'bkptline',
};

function u30At(buf, pos) {
  let v = 0, sh = 0, p = pos;
  for (let i = 0; i < 5; i++) { const x = buf[p++]; v |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; }
  return { value: v >>> 0, next: p };
}
function s24(b, pos) { let v = b[pos] | (b[pos + 1] << 8) | (b[pos + 2] << 16); if (v & 0x800000) v -= 0x1000000; return v; }

function disasmBody(b, body) {
  const code = body.code;
  const lines = [];
  let p = 0;
  const readU30 = () => { const d = u30At(code, p); p = d.next; return d.value; };
  const readStr = () => abc.str(readU30());
  const fmtMn = (i) => {
    let n = abc.mnName(i);
    if (n.length > 48) n = abc.simpleMnName(i);
    return '#' + i + ' (' + n + ')';
  };
  const readMn = () => fmtMn(readU30());

  while (p < code.length) {
    const off = p;
    const readOffset = () => { const t = s24(code, p); p += 3; return (off + 4 + t); };
    const op = code[p++];
    const name = OP[op] || ('op_' + op.toString(16));
    let operand = '';

    switch (op) {
      // 跳转（s24 相对偏移）
      case 0x0c: case 0x0d: case 0x0e: case 0x0f: case 0x10: case 0x11: case 0x12:
      case 0x13: case 0x14: case 0x15: case 0x16: case 0x17: case 0x18: case 0x19: case 0x1a:
        operand = '-> ' + readOffset(); break;
      case 0x1c: { // lookupswitch
        const def = off + readU30();
        const n = readU30();
        const cases = [];
        for (let i = 0; i <= n; i++) cases.push(off + readU30());
        operand = 'def=' + def + ' cases=[' + cases.join(',') + ']'; break;
      }
      case 0x24: operand = code[p++]; break; // pushbyte u8
      case 0x25: { const b0 = code[p], b1 = code[p + 1]; p += 2; operand = (b0 & 0x7f) | (b1 << 7); break; } // pushshort (2B)
      case 0x2c: case 0x06: case 0x07: operand = JSON.stringify(readStr()); break; // pushstring / dxns / dxnslate
      case 0x2d: operand = abc.ints[readU30()]; break; // pushint (pool idx)
      case 0x2e: operand = abc.uints[readU30()]; break; // pushuint
      case 0x2f: operand = abc.doubles[readU30()]; break; // pushdouble
      case 0x31: operand = 'ns#' + readU30(); break; // pushnamespace
      case 0x32: { const a = readU30(); const b = readU30(); operand = 'reg' + a + ' idx' + b; break; } // hasnext2
      case 0xef: { // debug
        const dt = code[p++];
        if (dt === 1 || dt === 3 || dt === 4 || dt === 5) {
          const nm = readU30(); const rg = code[p++]; const ex = readU30();
          operand = 't' + dt + ' ' + JSON.stringify(abc.str(nm)) + ' r' + rg + ' x' + ex;
        } else if (dt === 2) { operand = 'line=' + readU30(); }
        else if (dt === 6) { operand = 'file=' + JSON.stringify(abc.str(readU30())); }
        else { operand = 't' + dt; }
        break;
      }
      case 0x3d: p += 16; operand = '<float4>'; break; // pushfloat4
      case 0x40: { const i = readU30(); operand = fmtMn(i); break; } // newfunction (method idx)
      case 0x58: { const i = readU30(); operand = fmtMn(i); break; } // newclass
      case 0x43: case 0x44: case 0x45: { const i = readU30(); const ac = readU30(); operand = fmtMn(i) + ' argc=' + ac; break; } // callmethod/callstatic/callsuper
      case 0x46: case 0x4a: case 0x4c: case 0x4d: case 0x4e: case 0x4f: { const i = readU30(); const ac = readU30(); operand = fmtMn(i) + ' argc=' + ac; break; } // callproperty/constructprop/callproplex/callsupervoid/callpropvoid
      case 0x41: case 0x42: case 0x49: operand = 'argc=' + readU30(); break; // call/construct/constructsuper arg count
      case 0x04: case 0x05: case 0x59: case 0x5d: case 0x5e: case 0x60: case 0x61: case 0x66: case 0x67: case 0x68:
      case 0x80: case 0x86: {
        operand = readMn(); break; // multiname (coerce/astype/...)
      }
      case 0x53: case 0x55: case 0x56: operand = 'n=' + readU30(); break; // applytype/newobject/newarray
      case 0x08: case 0x62: case 0x63: case 0x65: case 0x6a: case 0x6b:
      case 0x6c: case 0x6d: case 0x92: case 0x94: case 0xc2: case 0xc3: case 0x5a:
        operand = '#' + readU30(); break; // u30 局部/槽位/寄存器
      case 0xb2: operand = readMn(); break; // istype
      case 0xf0: case 0xf1: case 0xf2: operand = readU30(); break; // debugline/debugfile/bkptline
      default: break;
    }
    lines.push(off.toString().padStart(4, ' ') + '  ' + name.padEnd(14) + ' ' + operand);
  }
  return lines.join('\n');
}

function findClassByName(name) { return abc.findInstance(name); }

function methodOf(found, methodName) {
  const allTraits = [].concat(found.instance.traits, found.klass ? found.klass.traits : []);
  for (const t of allTraits) {
    if (t.method === undefined) continue;
    if (abc.simpleMnName(t.name) !== methodName) continue;
    const body = abc.bodies.find((b) => b.method === t.method);
    return { trait: t, body };
  }
  return null;
}

if (className && !methodName && !dumpAll) {
  const f = findClassByName(className);
  if (!f) { console.error('类不存在: ' + className); process.exit(1); }
  const allTraits = [].concat(f.instance.traits, f.klass.traits);
  console.log('==== ' + className + ' (super=' + abc.mnName(f.instance.superName) + ') ====');
  for (const t of allTraits) {
    if (t.method === undefined) continue;
    const body = abc.bodies.find((b) => b.method === t.method);
    console.log('  [' + t.kind + '] ' + abc.simpleMnName(t.name) + '  methodIdx=' + t.method + ' body=' + (body ? 'Y' : 'N'));
  }
  process.exit(0);
}

if (className && methodName) {
  const f = findClassByName(className);
  if (!f) { console.error('类不存在: ' + className); process.exit(1); }
  const m = methodOf(f, methodName);
  if (!m || !m.body) { console.error('方法不存在或无方法体: ' + methodName); process.exit(1); }
  const mn = abc.methods[m.trait.method];
  console.log('==== ' + className + '.' + methodName + ' (methodIdx=' + m.trait.method + ' maxStack=' + m.body.maxStack + ' maxLocal=' + m.body.maxLocal + ' codeLen=' + m.body.codeLen + ' flags=' + (mn ? mn.flags : '?') + ') ====');
  console.log(disasmBody(abc.b, m.body));
  process.exit(0);
}

if (findStr) {
  // 找到引用该字符串/名称的常量索引，然后反汇编所有引用它的方法体
  const strIdx = abc.strings.indexOf(findStr);
  if (strIdx < 0) { console.error('字符串不存在: ' + findStr); process.exit(1); }
  console.log('字符串索引: ' + strIdx + ' = ' + JSON.stringify(findStr));
  // 遍历所有 body，找 pushstring strIdx
  const results = [];
  for (const body of abc.bodies) {
    const code = body.code;
    for (let p = 0; p < code.length;) {
      const op = code[p];
      if (op === 0x30) { // pushstring
        const d = u30At(code, p + 1);
        if (d.value === strIdx) {
          const method = abc.methods[body.method];
          // 找属于哪个类
          let owner = '?';
          outer:
          for (const inst of abc.instances) {
            const allTraits = [].concat(inst.traits, abc.classes[abc.instances.indexOf(inst)].traits);
            for (const t of allTraits) { if (t.method === body.method) { owner = abc.mnName(inst.name); break outer; } }
          }
          results.push({ owner, methodName: method ? abc.str(method.name) : '?', methodIdx: body.method });
          break;
        }
        p = d.next;
      } else {
        p++; // 粗略跳过（不精确，但对 pushstring 定位足够）
      }
      if (p >= code.length) break;
    }
  }
  console.log('引用该字符串的方法:');
  for (const r of results) console.log('  ' + r.owner + '.' + r.methodName + '  (methodIdx=' + r.methodIdx + ')');
  if (dumpAll && results.length) {
    for (const r of results) {
      const f = findClassByName(r.owner);
      if (!f) continue;
      const m = methodOf(f, r.methodName);
      if (!m || !m.body) continue;
      console.log('\n==== ' + r.owner + '.' + r.methodName + ' ====');
      console.log(disasmBody(abc.b, m.body));
    }
  }
  process.exit(0);
}

console.error('用法: --swf <file> [--class C] [--method M] | [--find S] [--all]');
process.exit(1);
