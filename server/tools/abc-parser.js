'use strict';
/**
 * 极简 AVM2 ABC 解析器（只读），用于客户端字节码补丁。
 * 记录方法体各字段的字节偏移，方便原地修改。
 */

class R {
  constructor(b) { this.b = b; this.p = 0; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.b[this.p] | (this.b[this.p + 1] << 8); this.p += 2; return v; }
  u32() { const v = (this.b[this.p] | (this.b[this.p + 1] << 8) | (this.b[this.p + 2] << 16) | (this.b[this.p + 3] << 24)) >>> 0; this.p += 4; return v; }
  f64() { const v = this.b.readDoubleLE(this.p); this.p += 8; return v; }
  bytes(n) { const v = this.b.slice(this.p, this.p + n); this.p += n; return v; }
  u30() { let v = 0, sh = 0; for (let i = 0; i < 5; i++) { const x = this.b[this.p++]; v |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; } return v >>> 0; }
  utf8(n) {
    const b = this.bytes(n);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { return Buffer.from(b).toString('latin1'); }
  }
}

class Abc {
  constructor(bytes) {
    this.r = new R(bytes);
    this.parse();
  }

  parse() {
    const r = this.r;
    this.minor = r.u16();
    this.major = r.u16();

    this.ints = [0];
    let n = r.u30();
    for (let i = 1; i < n; i++) this.ints.push(r.u30() | 0);

    this.uints = [0];
    n = r.u30();
    for (let i = 1; i < n; i++) this.uints.push(r.u30());

    this.doubles = [NaN];
    n = r.u30();
    for (let i = 1; i < n; i++) this.doubles.push(r.f64());

    this.strings = [''];
    n = r.u30();
    for (let i = 1; i < n; i++) this.strings.push(r.utf8(r.u30()));

    this.namespaces = [{ kind: 0, name: 0 }];
    n = r.u30();
    for (let i = 1; i < n; i++) this.namespaces.push({ kind: r.u8(), name: r.u30() });

    this.nsSets = [[]];
    n = r.u30();
    for (let i = 1; i < n; i++) {
      const c = r.u30();
      const a = [];
      for (let j = 0; j < c; j++) a.push(r.u30());
      this.nsSets.push(a);
    }

    this.multinames = [{ kind: 0, ns: 0, name: 0, nsSet: 0, base: 0, params: [] }];
    n = r.u30();
    for (let i = 1; i < n; i++) {
      const kind = r.u8();
      const m = { kind, ns: 0, name: 0, nsSet: 0, base: 0, params: [] };
      switch (kind) {
        case 0x07: case 0x0d: m.ns = r.u30(); m.name = r.u30(); break;
        case 0x0f: case 0x10: m.name = r.u30(); break;
        case 0x11: case 0x12: break;
        case 0x09: case 0x0e: m.name = r.u30(); m.nsSet = r.u30(); break;
        case 0x1b: case 0x1c: m.nsSet = r.u30(); break;
        case 0x1d: m.base = r.u30(); { const c = r.u30(); for (let j = 0; j < c; j++) m.params.push(r.u30()); } break;
        default: throw new Error('multiname kind ' + kind + ' at ' + i);
      }
      this.multinames.push(m);
    }

    this.methods = [];
    n = r.u30();
    for (let i = 0; i < n; i++) {
      const m = { paramTypes: [], optional: [], paramNames: [] };
      const pc = r.u30();
      m.returnType = r.u30();
      for (let j = 0; j < pc; j++) m.paramTypes.push(r.u30());
      m.name = r.u30();
      m.flags = r.u8();
      if (m.flags & 0x08) {
        const oc = r.u30();
        for (let j = 0; j < oc; j++) m.optional.push({ val: r.u30(), kind: r.u8() });
      }
      if (m.flags & 0x80) {
        for (let j = 0; j < pc; j++) m.paramNames.push(r.u30());
      }
      this.methods.push(m);
    }

    this.metadata = [];
    n = r.u30();
    for (let i = 0; i < n; i++) {
      const name = r.u30();
      const c = r.u30();
      const keys = [], values = [];
      for (let j = 0; j < c; j++) keys.push(r.u30());
      for (let j = 0; j < c; j++) values.push(r.u30());
      this.metadata.push({ name, keys, values });
    }

    this.instances = [];
    n = r.u30();
    for (let i = 0; i < n; i++) {
      const inst = { name: r.u30(), superName: r.u30(), flags: r.u8(), protectedNs: 0, interfaces: [], iinit: 0, traits: [] };
      if (inst.flags & 0x08) inst.protectedNs = r.u30();
      const ic = r.u30();
      for (let j = 0; j < ic; j++) inst.interfaces.push(r.u30());
      inst.iinit = r.u30();
      inst.traits = this.parseTraits(r);
      this.instances.push(inst);
    }

    this.classes = [];
    for (let i = 0; i < this.instances.length; i++) {
      this.classes.push({ cinit: r.u30(), traits: this.parseTraits(r) });
    }

    this.scripts = [];
    n = r.u30();
    for (let i = 0; i < n; i++) {
      this.scripts.push({ init: r.u30(), traits: this.parseTraits(r) });
    }

    this.bodies = [];
    n = r.u30();
    for (let i = 0; i < n; i++) {
      const b = { bodyStart: r.p };
      b.method = r.u30();
      b.maxStackPos = r.p;
      b.maxStack = r.u30();
      b.maxLocalPos = r.p;
      b.maxLocal = r.u30();
      b.initScope = r.u30();
      b.maxScope = r.u30();
      b.codeLenPos = r.p;
      const cl = r.u30();
      b.codeLen = cl;
      b.codeStart = r.p;
      b.code = r.bytes(cl);
      b.codeEnd = b.codeStart + cl;
      const ec = r.u30();
      b.exceptions = [];
      for (let j = 0; j < ec; j++) {
        b.exceptions.push({ from: r.u30(), to: r.u30(), target: r.u30(), excType: r.u30(), varName: r.u30() });
      }
      b.traits = this.parseTraits(r);
      b.bodyEnd = r.p;
      this.bodies.push(b);
    }
  }

  parseTraits(r) {
    const n = r.u30();
    const traits = [];
    for (let i = 0; i < n; i++) {
      const t = { name: r.u30(), kind: 0, attrs: 0 };
      const kt = r.u8();
      t.kind = kt & 0x0f;
      t.attrs = kt >> 4;
      if (t.kind === 0 || t.kind === 6) {
        t.slotId = r.u30();
        t.typeName = r.u30();
        t.valueIndex = r.u30();
        if (t.valueIndex) t.valueKind = r.u8();
      } else if (t.kind === 4) {
        t.slotId = r.u30();
        t.classIndex = r.u30();
      } else if (t.kind === 5) {
        t.slotId = r.u30();
        t.method = r.u30();
      } else {
        t.slotId = r.u30();
        t.method = r.u30();
      }
      if (t.attrs & 0x04) {
        const mc = r.u30();
        t.metadata = [];
        for (let j = 0; j < mc; j++) t.metadata.push(r.u30());
      }
      traits.push(t);
    }
    return traits;
  }

  str(i) { return this.strings[i] === undefined ? '#' + i : this.strings[i]; }

  nsName(i) {
    const ns = this.namespaces[i] || { kind: 0, name: 0 };
    return { kind: ns.kind, name: this.str(ns.name) };
  }

  mnName(i) {
    const m = this.multinames[i];
    if (!m) return '#' + i;
    const nm = m.name ? this.str(m.name) : '';
    if (m.kind === 0x07 || m.kind === 0x0d) {
      const ns = this.nsName(m.ns).name;
      return (ns ? ns + '::' : '') + nm;
    }
    if (m.kind === 0x09 || m.kind === 0x0e) {
      const ns = (this.nsSets[m.nsSet] || []).map((x) => this.nsName(x).name).filter(Boolean).join(',');
      return (ns ? ns + '::' : '') + nm;
    }
    if (m.kind === 0x1d) return nm + '<' + m.params.map((p) => this.mnName(p)).join(',') + '>';
    return nm || '#' + i;
  }

  simpleMnName(i) {
    const m = this.multinames[i];
    if (!m) return '#' + i;
    return m.name ? this.str(m.name) : this.mnName(i);
  }

  findInstance(className) {
    for (let i = 0; i < this.instances.length; i++) {
      const full = this.mnName(this.instances[i].name);
      const simple = this.simpleMnName(this.instances[i].name);
      if (full === className || simple === className) return { index: i, instance: this.instances[i], klass: this.classes[i] };
    }
    return null;
  }

  findMethodBody(className, methodName) {
    const found = this.findInstance(className);
    if (!found) return null;
    const allTraits = [].concat(found.instance.traits, found.klass ? found.klass.traits : []);
    for (const t of allTraits) {
      if (t.method === undefined) continue;
      if (this.simpleMnName(t.name) !== methodName) continue;
      const body = this.bodies.find((b) => b.method === t.method);
      if (body) return { methodIndex: t.method, body, trait: t };
    }
    return null;
  }
}

module.exports = { R, Abc };
