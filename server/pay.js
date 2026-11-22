#!/usr/bin/env node
/**
 * 战神三国充值 / 支付模块
 *
 * - 充值网站（/pay）：账号登录、套餐选择、微信 / 支付宝下单
 * - 订单：创建、查询、过期、支付回调
 * - 支付通道：
 *     sandbox  本地模拟支付（默认，便于先跑通流程）
 *     epay     彩虹易支付 / 同类聚合支付（支持微信、支付宝，需填 pid/key）
 * - 点卡发放：支付成功后进入待领取队列，游戏内 head=10009 或重新登录时到账
 *
 * 不依赖任何第三方 npm 包。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const DEFAULT_EPAY = {
  apiUrl: '',
  pid: '',
  key: '',
  channels: { wechat: 'wxpay', alipay: 'alipay' },
};

const DEFAULT_ALIPAY = {
  mode: 'page', // page = 电脑网站支付；wap = 手机网站支付；precreate = 当面付二维码
  appId: '',
  pid: '',
  gateway: 'https://openapi.alipay.com/gateway.do',
  signType: 'RSA2',
  privateKeyPath: '',
  privateKey: '',
  appCertPath: '',
  alipayCertPath: '',
  alipayRootCertPath: '',
  appCertSn: '',
  alipayRootCertSn: '',
  timeoutMs: 8000,
};

const DEFAULT_CONFIG = {
  siteName: '战神三国充值中心',
  gameName: '战神三国',
  baseUrl: 'auto',
  sessionSecret: '',
  sessionHours: 12,
  orderExpireMinutes: 30,
  diankaPerYuan: 10,
  provider: 'sandbox',
  epay: DEFAULT_EPAY,
  packages: [],
};

const CHANNELS = [
  { id: 'wechat', name: '微信支付' },
  { id: 'alipay', name: '支付宝' },
];

/* ----------------------------- 小工具 ----------------------------- */

function loadJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function randomHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ----------------------------- 充值服务 ----------------------------- */

class PayService {
  constructor(opts) {
    this.opts = opts;
    this.configFile = opts.configFile;
    this.dataDir = opts.dataDir;

    const loaded = loadJsonFile(opts.configFile, {});
    this.config = Object.assign({}, DEFAULT_CONFIG, loaded);
    this.config.epay = Object.assign({}, DEFAULT_EPAY, loaded.epay || {});
    this.config.epay.channels = Object.assign(
      {}, DEFAULT_EPAY.channels, (loaded.epay && loaded.epay.channels) || {}
    );
    this.config.alipay = Object.assign({}, DEFAULT_ALIPAY, loaded.alipay || {});
    if (!Array.isArray(this.config.packages)) this.config.packages = [];

    this.stateFile = path.join(this.dataDir, 'payments.json');
    this.state = loadJsonFile(this.stateFile, { orders: {} });
    if (!this.state || typeof this.state !== 'object') this.state = { orders: {} };
    if (!this.state.orders || typeof this.state.orders !== 'object') this.state.orders = {};

    this.pageFile = path.join(opts.rootDir, 'pay-page.html');
    this.maxBodyBytes = opts.maxBodyBytes || 1024 * 1024;
    this.loginFails = new Map();

    if (!this.config.sessionSecret || this.config.sessionSecret.indexOf('CHANGE_ME') !== -1) {
      console.warn('[pay] 警告: pay-config.json 的 sessionSecret 仍为默认值，正式环境请改成随机长字符串');
    }
    if (this.providerForChannel('alipay') === 'epay' && !this.epayConfigured()) {
      console.warn('[pay] 警告: 支付宝通道配置为 epay，但 epay.apiUrl / pid / key 尚未配置完整');
    }
    if (this.providerForChannel('alipay') === 'alipay' && !this.alipayConfigured()) {
      console.warn('[pay] 警告: 支付宝官方通道未配置完整（私钥/证书路径或 appId）');
    }

    // 支付宝异步通知可能因为网络 / 回调地址 / 验签失败而丢失。
    // 这里每分钟主动向支付宝查单，把“已经付款但服务端仍是 pending”的订单补记为已支付。
    // 这样玩家即使不回到充值页、不点“重新查询”，下次登录 / 点商城也能拿到点卡。
    this._syncTimer = setInterval(() => {
      this.syncPendingAlipayOrders().catch((e) => {
        console.warn('[pay] 自动补单失败', e && e.message ? e.message : e);
      });
    }, 60 * 1000);
    if (this._syncTimer.unref) this._syncTimer.unref();
  }

  /**
   * 主动查询支付宝待支付订单。每次最多查 5 单，避免触发支付宝频率限制。
   * 只处理 24 小时内创建、且 45 秒内没查过的订单。
   */
  async syncPendingAlipayOrders() {
    if (this.providerForChannel('alipay') !== 'alipay' || !this.alipayConfigured()) return;
    const now = Date.now();
    const candidates = Object.values(this.state.orders).filter((o) =>
      o && o.status === 'pending' && o.provider === 'alipay' &&
      Number(o.createdAt) > now - 24 * 3600 * 1000 &&
      (!o.lastQueryAt || now - Number(o.lastQueryAt) > 45 * 1000)
    ).slice(0, 5);
    for (const order of candidates) {
      if (Number(order.expiresAt) > 0 && now > Number(order.expiresAt)) {
        order.status = 'expired';
        this.saveState();
        continue;
      }
      try {
        await this.alipayQuery(order);
      } catch (e) {
        console.warn('[pay] 自动查单失败', order.orderNo, e && e.message ? e.message : e);
      }
    }
  }

  /* ---------- 持久化 ---------- */

  saveState() {
    atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  /* ---------- 请求辅助 ---------- */

  readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > limit) {
          done = true;
          req.destroy();
          reject(new HttpError(413, '请求体过大'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!done) resolve(Buffer.concat(chunks));
      });
      req.on('error', (e) => {
        if (!done) reject(e);
      });
    });
  }

  async readJson(req) {
    const raw = await this.readBody(req, this.maxBodyBytes);
    if (!raw.length) return {};
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      throw new HttpError(400, '请求格式错误');
    }
  }

  parseCookies(req) {
    const out = {};
    const header = req.headers.cookie || '';
    header.split(';').forEach((part) => {
      const i = part.indexOf('=');
      if (i <= 0) return;
      const key = part.slice(0, i).trim();
      if (!key) return;
      try {
        out[key] = decodeURIComponent(part.slice(i + 1).trim());
      } catch (e) {
        out[key] = part.slice(i + 1).trim();
      }
    });
    return out;
  }

  isHttps(req) {
    if (this.config.forceSecure === true) return true;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    return proto === 'https' || Boolean(req.socket && req.socket.encrypted);
  }

  setCookie(req, res, name, value, maxAge) {
    const parts = [
      name + '=' + encodeURIComponent(value),
      'Path=/pay',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=' + Math.max(0, Math.floor(maxAge)),
    ];
    if (this.isHttps(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  clearCookie(req, res, name) {
    this.setCookie(req, res, name, '', 0);
  }

  clientIp(req) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return xff || (req.socket && req.socket.remoteAddress) || '';
  }

  baseUrl(req) {
    if (this.config.baseUrl && this.config.baseUrl !== 'auto') {
      return String(this.config.baseUrl).replace(/\/+$/, '');
    }
    const proto = this.isHttps(req) ? 'https' : 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:8080';
    return proto + '://' + host;
  }

  sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  sendText(res, status, text, type) {
    const body = String(text);
    res.writeHead(status, {
      'Content-Type': (type || 'text/plain') + '; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  sendHtml(res, status, html) {
    this.sendText(res, status, html, 'text/html');
  }

  /* ---------- 会话 ---------- */

  makeSession(userID, username) {
    const hours = Number(this.config.sessionHours) > 0 ? Number(this.config.sessionHours) : 12;
    const payload = { u: userID, n: username, e: Date.now() + hours * 3600 * 1000 };
    const data = b64url(JSON.stringify(payload));
    const sig = crypto.createHmac('sha256', String(this.config.sessionSecret)).update(data).digest('base64url');
    return data + '.' + sig;
  }

  readSession(req) {
    const token = this.parseCookies(req).pay_sid;
    if (!token) return null;
    const idx = token.lastIndexOf('.');
    if (idx <= 0) return null;
    const data = token.slice(0, idx);
    const sig = token.slice(idx + 1);
    const expected = crypto.createHmac('sha256', String(this.config.sessionSecret)).update(data).digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      if (!payload || !payload.u || !payload.n || !payload.e) return null;
      if (Number(payload.e) < Date.now()) return null;
      return payload;
    } catch (e) {
      return null;
    }
  }

  findUserRecord(session) {
    if (!session) return null;
    const db = this.opts.loadUsers();
    const user = db && db.users && db.users[session.n];
    if (!user || user.userID !== session.u) return null;
    return { username: session.n, user };
  }

  userInfo(session) {
    const found = this.findUserRecord(session);
    if (!found) return null;
    const save = this.opts.readSave(found.user.userID) || null;
    return {
      userID: found.user.userID,
      username: found.username,
      roleName: save && save.roleModel ? String(save.roleModel.roleName || '') : '',
      dianka: save ? Math.max(0, Math.floor(Number(save.dianka) || 0)) : 0,
    };
  }

  /* ---------- 订单 ---------- */

  newOrderNo() {
    let no;
    do {
      no = 'P' + Date.now().toString(36).toUpperCase() + randomHex(3).toUpperCase();
    } while (this.state.orders[no]);
    return no;
  }

  maybeExpire(order) {
    if (!order) return order;
    if (order.status === 'pending' && Number(order.expiresAt) > 0 && Date.now() > Number(order.expiresAt)) {
      order.status = 'expired';
      this.saveState();
    }
    return order;
  }

  expireStaleOrders() {
    const now = Date.now();
    let changed = false;
    for (const o of Object.values(this.state.orders)) {
      if (o && o.status === 'pending' && Number(o.expiresAt) > 0 && now > Number(o.expiresAt)) {
        o.status = 'expired';
        changed = true;
      }
    }
    if (changed) this.saveState();
  }

  findPackage(id) {
    return this.config.packages.find((p) => String(p.id) === String(id)) || null;
  }

  validatePackage(pkg) {
    if (!pkg) return '充值套餐不存在';
    const rmb = money(pkg.rmb);
    const dianka = Math.floor(money(pkg.dianka));
    if (!(rmb > 0) || !(dianka > 0)) return '充值套餐配置无效';
    if (rmb > 100000) return '充值金额过大';
    return null;
  }

  pendingOrders(userID) {
    return Object.values(this.state.orders).filter(
      (o) => o && o.userID === userID && o.status === 'paid' && !o.claimed
    );
  }

  pendingTotal(userID) {
    return this.pendingOrders(userID).reduce((sum, o) => sum + Math.max(0, Math.floor(Number(o.dianka) || 0)), 0);
  }

  markCredited(orderNos) {
    if (!Array.isArray(orderNos) || !orderNos.length) return;
    let changed = false;
    for (const no of orderNos) {
      const o = this.state.orders[no];
      if (!o || o.claimed) continue;
      o.claimed = true;
      o.claimedAt = Date.now();
      o.status = 'credited';
      changed = true;
    }
    if (changed) this.saveState();
  }

  cleanupOrders() {
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    let changed = false;
    for (const no of Object.keys(this.state.orders)) {
      const o = this.state.orders[no];
      if (!o) {
        delete this.state.orders[no];
        changed = true;
        continue;
      }
      const closable = o.claimed || ['expired', 'closed', 'failed'].includes(o.status);
      if (Number(o.createdAt) < cutoff && closable) {
        delete this.state.orders[no];
        changed = true;
      }
    }
    if (changed) this.saveState();
  }

  markOrderPaid(order, tradeNo, provider) {
    if (!order) return false;
    if (order.status === 'paid' || order.status === 'credited') return false;
    order.status = 'paid';
    order.paidAt = Date.now();
    order.tradeNo = String(tradeNo || '');
    order.provider = provider || order.provider;
    this.saveState();
    console.log(
      '[pay] 支付成功', order.orderNo,
      '账号=' + order.username,
      '金额=' + money(order.rmb).toFixed(2),
      '点卡=' + order.dianka,
      '通道=' + order.provider
    );
    return true;
  }

  orderPublic(order) {
    return {
      orderNo: order.orderNo,
      packageId: order.packageId,
      packageName: order.packageName,
      rmb: money(order.rmb),
      dianka: Math.floor(money(order.dianka)),
      bonus: Math.floor(money(order.bonus)),
      channel: order.channel,
      status: order.status,
      paid: order.status === 'paid' || order.status === 'credited',
      claimed: Boolean(order.claimed),
      createdAt: order.createdAt,
      paidAt: order.paidAt || 0,
      expiresAt: order.expiresAt || 0,
    };
  }

  /* ---------- 易支付签名 ---------- */

  epaySign(params) {
    const key = String(this.config.epay.key || '');
    const keys = Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] != null)
      .sort();
    const text = keys.map((k) => k + '=' + params[k]).join('&') + key;
    return crypto.createHash('md5').update(text, 'utf8').digest('hex');
  }

  buildPayUrl(order, req) {
    const provider = order.provider || this.providerForChannel(order.channel);
    if (provider === 'sandbox') {
      return '/pay/sandbox/' + encodeURIComponent(order.orderNo);
    }
    if (provider === 'alipay') {
      const mode = String(this.config.alipay.mode || 'page').toLowerCase();
      if (mode === 'precreate') {
        return '/pay/alipay/qr?order=' + encodeURIComponent(order.orderNo);
      }
      return '/pay/alipay/pay?order=' + encodeURIComponent(order.orderNo);
    }
    if (provider !== 'epay') throw new HttpError(503, '支付通道未配置');
    const epay = this.config.epay;
    const base = this.baseUrl(req);
    const params = {
      pid: epay.pid,
      type: epay.channels[order.channel] || order.channel,
      out_trade_no: order.orderNo,
      notify_url: base + '/pay/notify',
      return_url: base + '/pay/return?order=' + encodeURIComponent(order.orderNo),
      name: this.config.gameName + ' ' + order.packageName,
      money: money(order.rmb).toFixed(2),
      sitename: this.config.siteName,
    };
    params.sign = this.epaySign(params);
    params.sign_type = 'MD5';
    const sep = epay.apiUrl.indexOf('?') === -1 ? '?' : '&';
    return epay.apiUrl + sep + new URLSearchParams(params).toString();
  }

  providerForChannel(channel) {
    const map = this.config.channelProviders;
    if (map && typeof map === 'object' && Object.keys(map).length) {
      return map[channel] ? String(map[channel]) : '';
    }
    return String(this.config.provider || 'sandbox');
  }

  epayConfigured() {
    const e = this.config.epay;
    return Boolean(e && e.apiUrl && e.pid && e.key);
  }

  alipayConfigured() {
    const a = this.config.alipay;
    if (!a || !a.appId) return false;
    if (!a.privateKey && !a.privateKeyPath) return false;
    if (!a.appCertPath || !a.alipayCertPath || !a.alipayRootCertPath) return false;
    try {
      if (!a.privateKey && a.privateKeyPath && !fs.existsSync(a.privateKeyPath)) return false;
      if (!fs.existsSync(a.appCertPath)) return false;
      if (!fs.existsSync(a.alipayCertPath)) return false;
      if (!fs.existsSync(a.alipayRootCertPath)) return false;
    } catch (e) {
      return false;
    }
    return true;
  }

  providerReadyFor(channel) {
    const provider = this.providerForChannel(channel);
    if (!provider) return false;
    if (provider === 'sandbox') return true;
    if (provider === 'epay') return this.epayConfigured();
    if (provider === 'alipay') return this.alipayConfigured();
    return false;
  }

  /* ---------- 支付宝官方直连（证书模式） ---------- */

  loadAlipay() {
    if (this._alipay) return this._alipay;
    const a = this.config.alipay;
    if (!this.alipayConfigured()) {
      throw new HttpError(503, '支付宝官方通道未配置完整，请检查 pay-config.json 的 alipay 配置');
    }
    const privateKey = this.loadAlipayPrivateKey(a);
    const appCert = new crypto.X509Certificate(fs.readFileSync(a.appCertPath));
    const alipayCert = new crypto.X509Certificate(fs.readFileSync(a.alipayCertPath));
    const rootPem = fs.readFileSync(a.alipayRootCertPath);
    const alipayPublicKey = alipayCert.publicKey;

    this._alipay = {
      privateKey,
      alipayPublicKey,
      appCertSn: String(a.appCertSn || this.alipayCertSn(appCert)),
      alipayRootCertSn: String(a.alipayRootCertSn || this.alipayRootCertSn(rootPem)),
      appId: String(a.appId),
      pid: String(a.pid || ''),
      gateway: String(a.gateway || DEFAULT_ALIPAY.gateway).replace(/\?+$/, ''),
      mode: String(a.mode || 'page').toLowerCase(),
      signType: String(a.signType || 'RSA2'),
    };
    console.log('[pay] 支付宝官方通道已加载', {
      appId: this._alipay.appId,
      pid: this._alipay.pid,
      mode: this._alipay.mode,
      appCertSn: this._alipay.appCertSn,
    });
    if (!this._alipay.alipayRootCertSn) {
      console.warn('[pay] 警告: 支付宝根证书序列号为空，请检查 alipayRootCertPath 文件');
    }
    return this._alipay;
  }

  loadAlipayPrivateKey(a) {
    let text = a.privateKey ? String(a.privateKey) : fs.readFileSync(a.privateKeyPath, 'utf8');
    text = text.trim();
    if (text.indexOf('-----BEGIN') !== -1) {
      return crypto.createPrivateKey(text);
    }
    const body = text.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
    try {
      return crypto.createPrivateKey('-----BEGIN PRIVATE KEY-----\n' + body + '\n-----END PRIVATE KEY-----\n');
    } catch (e) {
      return crypto.createPrivateKey('-----BEGIN RSA PRIVATE KEY-----\n' + body + '\n-----END RSA PRIVATE KEY-----\n');
    }
  }

  /** 与支付宝官方 SDK 一致：MD5(issuer RFC2253 + 十进制 serial) */
  alipayCertSn(cert) {
    const issuer = String(cert.issuer || '');
    const principalName = issuer
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .reverse()
      .join(',');
    const serialHex = String(cert.serialNumber || '').replace(/[^0-9a-fA-F]/g, '');
    const decimal = serialHex ? BigInt('0x' + serialHex).toString(10) : '0';
    return crypto.createHash('md5').update(principalName + decimal, 'utf8').digest('hex');
  }

  alipayRootCertSn(pem) {
    const blocks = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    const sns = [];
    for (const block of blocks) {
      try {
        const cert = new crypto.X509Certificate(block);
        const alg = String(cert.signatureAlgorithm || '').toLowerCase();
        // Node 20 的 X509Certificate 没有 signatureAlgorithm，回退到公钥类型
        const pubType = String((cert.publicKey && cert.publicKey.asymmetricKeyType) || '').toLowerCase();
        const isRsa = alg
          ? (alg.indexOf('rsa') !== -1 || alg.indexOf('1.2.840.113549.1.1') === 0)
          : pubType === 'rsa';
        if (!isRsa) continue; // 支付宝 SDK 只纳入 RSA 签名证书
        sns.push(this.alipayCertSn(cert));
      } catch (e) {
        /* 跳过无法解析的证书 */
      }
    }
    return sns.join('_');
  }

  alipayTimestamp() {
    const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
      `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }

  alipaySignParams(params, client) {
    if (client.signType !== 'RSA2') {
      throw new HttpError(500, '当前仅支持支付宝 RSA2 签名');
    }
    const keys = Object.keys(params)
      .filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== null)
      .sort();
    const content = keys.map((k) => k + '=' + params[k]).join('&');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(content, 'utf8');
    signer.end();
    return signer.sign(client.privateKey, 'base64');
  }

  alipayCommonParams(client, method, bizContent, extra) {
    const params = {
      app_id: client.appId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: client.signType,
      timestamp: this.alipayTimestamp(),
      version: '1.0',
      app_cert_sn: client.appCertSn,
      alipay_root_cert_sn: client.alipayRootCertSn,
    };
    if (bizContent) params.biz_content = JSON.stringify(bizContent);
    if (extra) Object.assign(params, extra);
    params.sign = this.alipaySignParams(params, client);
    return params;
  }

  /** 与支付宝 SDK getSignStr 相同：从原始 JSON 中截取 xxx_response 原文用于验签 */
  alipayResponseSignContent(raw, responseKey) {
    const origin = String(raw || '');
    let value = origin.trim();
    const startIndex = origin.indexOf(responseKey + '"');
    const lastIndex = origin.lastIndexOf('"sign"');
    if (startIndex === -1 || lastIndex === -1) return '';
    value = value.substring(startIndex + responseKey.length + 1);
    value = value.substring(0, lastIndex);
    value = value.replace(/^[^{]*{/g, '{');
    value = value.replace(/\}([^}]*)$/g, '}');
    return value;
  }

  alipayPost(method, bizContent, extra) {
    const client = this.loadAlipay();
    const params = this.alipayCommonParams(client, method, bizContent, extra);
    const body = new URLSearchParams(params).toString();
    const timeout = Math.max(1000, Number(this.config.alipay.timeoutMs) || 8000);
    return new Promise((resolve, reject) => {
      const gateway = new URL(client.gateway);
      const req = https.request({
        hostname: gateway.hostname,
        port: gateway.port || 443,
        path: gateway.pathname + (gateway.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch (e) {
            return reject(new HttpError(502, '支付宝返回格式错误: ' + text.slice(0, 300)));
          }
          const responseKey = method.replace(/\./g, '_') + '_response';
          const node = json[responseKey];
          if (!node) return reject(new HttpError(502, '支付宝返回缺少 ' + responseKey));
          if (json.sign) {
            const content = this.alipayResponseSignContent(text, responseKey);
            const verifier = crypto.createVerify('RSA-SHA256');
            verifier.update(content, 'utf8');
            verifier.end();
            if (!verifier.verify(client.alipayPublicKey, json.sign, 'base64')) {
              return reject(new HttpError(502, '支付宝响应验签失败'));
            }
          }
          resolve(node);
        });
      });
      req.on('timeout', () => req.destroy(new HttpError(504, '支付宝请求超时')));
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /* ---------- 支付宝支付页面 / 二维码 ---------- */

  alipayBiz(order, productCode) {
    const minutes = Math.max(1, Number(this.config.orderExpireMinutes) || 30);
    return {
      out_trade_no: order.orderNo,
      total_amount: money(order.rmb).toFixed(2),
      subject: this.config.gameName + ' ' + order.packageName,
      product_code: productCode,
      timeout_express: minutes + 'm',
    };
  }

  alipayPageForm(order, req) {
    const client = this.loadAlipay();
    const isWap = client.mode === 'wap';
    const method = isWap ? 'alipay.trade.wap.pay' : 'alipay.trade.page.pay';
    const productCode = isWap ? 'QUICK_WAP_WAY' : 'FAST_INSTANT_TRADE_PAY';
    const base = this.baseUrl(req);
    const biz = this.alipayBiz(order, productCode);
    const extra = {
      notify_url: base + '/pay/alipay/notify',
      return_url: base + '/pay/return?order=' + encodeURIComponent(order.orderNo),
    };
    const params = this.alipayCommonParams(client, method, biz, extra);
    const action = client.gateway + (client.gateway.indexOf('?') === -1 ? '?charset=utf-8' : '&charset=utf-8');
    const inputs = Object.keys(params).map((k) =>
      '<input type="hidden" name="' + escapeHtml(k) + '" value="' + escapeHtml(params[k]) + '">'
    ).join('');
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>正在跳转支付宝…</title>' +
      '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#0d1117;color:#e6edf3;font-family:-apple-system,"Microsoft YaHei",sans-serif;}' +
      '.box{text-align:center}.spin{width:38px;height:38px;margin:0 auto 16px;border-radius:50%;' +
      'border:3px solid #233044;border-top-color:#2f81f7;animation:s .8s linear infinite}' +
      '@keyframes s{to{transform:rotate(360deg)}}p{color:#8b949e}</style></head><body>' +
      '<div class="box"><div class="spin"></div><h2>正在跳转支付宝收银台…</h2>' +
      '<p>如果没有自动跳转，请点击下面的按钮。</p>' +
      '<form id="alipay-form" method="post" accept-charset="utf-8" action="' + escapeHtml(action) + '">' +
      inputs + '<button type="submit" style="padding:12px 22px;border-radius:10px;border:0;' +
      'background:#2f81f7;color:#fff;font-size:15px;font-weight:700;cursor:pointer">前往支付宝支付</button>' +
      '</form></div><script>document.getElementById("alipay-form").submit()</script></body></html>';
  }

  alipayQrSvg(text) {
    const qrcode = require('./vendor/qrcode-generator');
    const qr = qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 8, alt: '支付宝支付二维码' });
  }

  alipayQrPage(order, svg) {
    const no = encodeURIComponent(order.orderNo);
    const done = order.status === 'paid' || order.status === 'credited';
    const body = done
      ? '<div class="ok">✅ 支付成功</div><p>点卡正在等待你在游戏内领取。</p>' +
        '<p><a class="btn" href="/pay/return?order=' + no + '">查看订单状态</a></p>'
      : '<div class="qr">' + svg + '</div>' +
        '<p>请使用 <b>支付宝 App</b> 扫描上方二维码完成支付</p>' +
        '<p class="muted">支付成功后本页会自动跳转，也可以返回游戏领取点卡。</p>' +
        '<p><a class="btn ghost" href="/pay/return?order=' + no + '">我已完成支付</a></p>';
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>支付宝扫码支付 - ' + escapeHtml(order.orderNo) + '</title>' +
      '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#0d1117;color:#e6edf3;font-family:-apple-system,"Microsoft YaHei",sans-serif;padding:20px}' +
      '.card{width:min(440px,94vw);background:#161b22;border:1px solid #30363d;border-radius:18px;' +
      'padding:26px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.5)}' +
      'h1{font-size:19px;margin:0 0 6px}.amount{font-size:32px;font-weight:900;color:#f0b429;margin:12px 0}' +
      '.qr{background:#fff;border-radius:14px;padding:10px;display:inline-block;margin:10px 0}' +
      '.qr svg{display:block;width:240px;height:240px}' +
      'p{color:#aab6c5;line-height:1.7;font-size:13px;margin:8px 0}.muted{color:#6e7681;font-size:12px}' +
      '.ok{font-size:22px;font-weight:900;color:#5bd47a;margin:20px 0}' +
      '.btn{display:inline-block;margin-top:10px;padding:11px 18px;border-radius:10px;background:#f0b429;' +
      'color:#241a05;text-decoration:none;font-weight:800}.btn.ghost{background:#21262d;color:#c9d1d9;' +
      'border:1px solid #30363d}.meta{text-align:left;margin-top:18px;border-top:1px solid #21262d;padding-top:12px}' +
      '.meta div{display:flex;justify-content:space-between;gap:10px;padding:6px 0;font-size:12px}' +
      '.meta span:first-child{color:#8b949e}.meta span:last-child{word-break:break-all;text-align:right}' +
      '</style></head><body><div class="card">' +
      '<h1>' + escapeHtml(order.packageName) + '</h1>' +
      '<div class="amount">¥' + money(order.rmb).toFixed(2) + '</div>' +
      body +
      '<div class="meta"><div><span>订单号</span><span>' + escapeHtml(order.orderNo) + '</span></div>' +
      '<div><span>到账点卡</span><span>' + Math.floor(money(order.dianka)) + '</span></div></div>' +
      '</div>' +
      (done ? '' : '<script>setInterval(function(){fetch("/pay/api/order?no=' + no + '")' +
        '.then(function(r){return r.json()}).then(function(d){if(d.order&&(d.order.status==="paid"||d.order.status==="credited")){location.href="/pay/return?order=' + no + '"}})'
        + '.catch(function(){});},2500)</script>') +
      '</body></html>';
  }

  alipayErrorPage(title, message) {
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>支付失败</title>' +
      '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#0d1117;color:#e6edf3;font-family:-apple-system,"Microsoft YaHei",sans-serif;padding:20px}' +
      '.card{width:min(480px,94vw);background:#161b22;border:1px solid #30363d;border-radius:16px;padding:26px}' +
      'h1{font-size:20px;margin:0 0 12px;color:#ff8b84}p{color:#aab6c5;line-height:1.7;font-size:13px;word-break:break-all}' +
      'a{display:inline-block;margin-top:18px;padding:11px 18px;border-radius:10px;background:#f0b429;' +
      'color:#241a05;text-decoration:none;font-weight:800}</style></head><body><div class="card">' +
      '<h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(message) + '</p>' +
      '<p>如果提示无权限，请在 pay-config.json 里把 alipay.mode 改成 page（电脑网站支付）或 precreate（当面付），' +
      '并确认开放平台已签约对应产品。</p><a href="/pay">返回充值页</a></div></body></html>';
  }

  async serveAlipayPay(req, res, url) {
    const no = String(url.searchParams.get('order') || '');
    const order = this.state.orders[no];
    if (!order || order.provider !== 'alipay') return this.sendText(res, 404, '订单不存在');
    this.maybeExpire(order);
    if (order.status === 'paid' || order.status === 'credited') {
      res.writeHead(302, { Location: '/pay/return?order=' + encodeURIComponent(order.orderNo), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (order.status !== 'pending') {
      return this.sendHtml(res, 400, this.alipayErrorPage('订单不可支付', '订单状态：' + order.status));
    }
    try {
      return this.sendHtml(res, 200, this.alipayPageForm(order, req));
    } catch (e) {
      return this.sendHtml(res, 500, this.alipayErrorPage('生成支付宝支付页失败', e.message));
    }
  }

  async serveAlipayQr(req, res, url) {
    const no = String(url.searchParams.get('order') || '');
    const order = this.state.orders[no];
    if (!order || order.provider !== 'alipay') return this.sendText(res, 404, '订单不存在');
    this.maybeExpire(order);
    if (order.status === 'paid' || order.status === 'credited') {
      return this.sendHtml(res, 200, this.alipayQrPage(order, ''));
    }
    if (order.status !== 'pending') {
      return this.sendHtml(res, 400, this.alipayErrorPage('订单不可支付', '订单状态：' + order.status));
    }
    try {
      if (!order.qrCode) {
        const node = await this.alipayPost(
          'alipay.trade.precreate',
          this.alipayBiz(order, 'FACE_TO_FACE_PAYMENT'),
          { notify_url: this.baseUrl(req) + '/pay/alipay/notify' }
        );
        if (String(node.code) !== '10000' || !node.qr_code) {
          throw new Error(node.sub_msg || node.msg || '支付宝未返回二维码');
        }
        order.qrCode = String(node.qr_code);
        order.qrCreatedAt = Date.now();
        this.saveState();
        console.log('[pay] 支付宝当面付二维码已生成', order.orderNo);
      }
      return this.sendHtml(res, 200, this.alipayQrPage(order, this.alipayQrSvg(order.qrCode)));
    } catch (e) {
      console.error('[pay] 生成支付宝二维码失败', e.message);
      return this.sendHtml(res, 500, this.alipayErrorPage('生成支付宝二维码失败', e.message));
    }
  }

  /* ---------- 支付宝异步通知 ---------- */

  alipayNotifySignContent(params, includeSignType) {
    const copy = Object.assign({}, params);
    delete copy.sign;
    if (!includeSignType) delete copy.sign_type;
    return Object.keys(copy)
      .filter((k) => k)
      .sort()
      .map((k) => k + '=' + copy[k])
      .join('&');
  }

  alipayVerifyNotify(params, client) {
    const sign = String(params.sign || '');
    if (!sign) return false;
    const signType = String(params.sign_type || client.signType);
    if (signType !== 'RSA2') return false;
    for (const includeSignType of [true, false]) {
      const content = this.alipayNotifySignContent(params, includeSignType);
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(content, 'utf8');
      verifier.end();
      if (verifier.verify(client.alipayPublicKey, sign, 'base64')) return true;
    }
    return false;
  }

  async alipayNotify(req, res, url) {
    const params = {};
    if (req.method === 'POST') {
      const raw = await this.readBody(req, this.maxBodyBytes);
      const form = new URLSearchParams(raw.toString('utf8'));
      for (const [k, v] of form) params[k] = v;
    } else {
      for (const [k, v] of url.searchParams) params[k] = v;
    }
    const client = this.loadAlipay();
    if (!this.alipayVerifyNotify(params, client)) {
      console.warn('[pay] 支付宝回调验签失败', params.out_trade_no || '');
      return this.sendText(res, 400, 'fail');
    }
    if (String(params.app_id) !== client.appId) {
      console.warn('[pay] 支付宝回调 app_id 不匹配', params.app_id);
      return this.sendText(res, 400, 'fail');
    }
    if (client.pid && String(params.seller_id) !== client.pid) {
      console.warn('[pay] 支付宝回调 seller_id 不匹配', params.seller_id);
      return this.sendText(res, 400, 'fail');
    }
    const order = this.state.orders[String(params.out_trade_no || '')];
    if (!order) {
      console.warn('[pay] 支付宝回调订单不存在', params.out_trade_no);
      return this.sendText(res, 404, 'fail');
    }
    if (money(params.total_amount).toFixed(2) !== money(order.rmb).toFixed(2)) {
      console.warn('[pay] 支付宝回调金额不匹配', order.orderNo, params.total_amount, order.rmb);
      return this.sendText(res, 400, 'fail');
    }
    const status = String(params.trade_status || '');
    if (status === 'TRADE_CLOSED') {
      if (order.status === 'pending') {
        order.status = 'closed';
        order.closedAt = Date.now();
        this.saveState();
      }
      return this.sendText(res, 200, 'success');
    }
    if (status !== 'TRADE_SUCCESS' && status !== 'TRADE_FINISHED') {
      return this.sendText(res, 200, 'success');
    }
    this.markOrderPaid(order, params.trade_no, 'alipay');
    return this.sendText(res, 200, 'success');
  }

  /* ---------- 主动查单 ---------- */

  async alipayQuery(order) {
    order.lastQueryAt = Date.now();
    this.saveState();
    const node = await this.alipayPost('alipay.trade.query', { out_trade_no: order.orderNo }, {});
    if (String(node.code) !== '10000') {
      if (String(node.sub_code) === 'ACQ.TRADE_NOT_EXIST') return order;
      throw new HttpError(502, node.sub_msg || node.msg || '支付宝查单失败');
    }
    const status = String(node.trade_status || '');
    if (status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED') {
      this.markOrderPaid(order, node.trade_no, 'alipay');
    } else if (status === 'TRADE_CLOSED' && order.status === 'pending') {
      order.status = 'closed';
      order.closedAt = Date.now();
      this.saveState();
    }
    return order;
  }

  async apiQueryOrder(req, res) {
    const session = this.readSession(req);
    const found = this.findUserRecord(session);
    if (!found) throw new HttpError(401, '请先登录');
    const body = await this.readJson(req);
    const no = String(body.orderNo || '');
    const order = this.state.orders[no];
    if (!order || order.userID !== found.user.userID) throw new HttpError(404, '订单不存在');
    if (order.status === 'pending' && order.provider === 'alipay' &&
        (!order.lastQueryAt || Date.now() - Number(order.lastQueryAt) > 3000)) {
      try {
        await this.alipayQuery(order);
      } catch (e) {
        console.warn('[pay] 支付宝查单失败', no, e.message);
      }
    }
    this.sendJson(res, 200, { ok: true, order: this.orderPublic(order) });
  }

  /* ---------- 路由 ---------- */

  async handle(req, res, url) {
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/pay' || p === '/pay/')) {
        return this.servePage(res);
      }
      if (req.method === 'GET' && p === '/pay/api/bootstrap') {
        return this.apiBootstrap(req, res);
      }
      if (req.method === 'POST' && p === '/pay/api/login') {
        return await this.apiLogin(req, res);
      }
      if (req.method === 'POST' && p === '/pay/api/logout') {
        return this.apiLogout(req, res);
      }
      if (req.method === 'GET' && p === '/pay/api/packages') {
        return this.apiPackages(req, res);
      }
      if (req.method === 'GET' && p === '/pay/api/orders') {
        return this.apiOrders(req, res);
      }
      if (req.method === 'POST' && p === '/pay/api/order') {
        return await this.apiCreateOrder(req, res);
      }
      if (req.method === 'GET' && p === '/pay/api/order') {
        return this.apiOrderStatus(req, res, url);
      }
      if (req.method === 'POST' && p === '/pay/api/order/query') {
        return await this.apiQueryOrder(req, res);
      }
      if (req.method === 'GET' && p === '/pay/alipay/pay') {
        return await this.serveAlipayPay(req, res, url);
      }
      if (req.method === 'GET' && p === '/pay/alipay/qr') {
        return await this.serveAlipayQr(req, res, url);
      }
      if ((req.method === 'GET' || req.method === 'POST') && p === '/pay/alipay/notify') {
        return await this.alipayNotify(req, res, url);
      }
      if (req.method === 'GET' && p === '/pay/return') {
        return this.servePage(res);
      }
      if ((req.method === 'GET' || req.method === 'POST') && p === '/pay/notify') {
        return await this.notify(req, res, url);
      }
      if (p.indexOf('/pay/sandbox/') === 0) {
        return await this.sandbox(req, res, url);
      }
      return this.sendText(res, 404, 'Not Found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error('[pay]', e);
      if (res.headersSent) {
        try { res.end(); } catch (e2) { /* ignore */ }
        return;
      }
      return this.sendJson(res, status, { ok: false, message: e.message || '服务器内部错误' });
    }
  }

  servePage(res) {
    let html;
    try {
      html = fs.readFileSync(this.pageFile, 'utf8');
    } catch (e) {
      html = '<!doctype html><meta charset="utf-8"><h1>充值页面缺失</h1>' +
        '<p>服务端缺少 pay-page.html，请检查部署文件。</p>';
    }
    this.sendHtml(res, 200, html);
  }

  /* ---------- API ---------- */

  apiBootstrap(req, res) {
    const session = this.readSession(req);
    const user = session ? this.userInfo(session) : null;
    const channels = CHANNELS.map((c) => {
      const provider = this.providerForChannel(c.id);
      return Object.assign({}, c, { provider, ready: this.providerReadyFor(c.id) });
    });
    const readyChannels = channels.filter((c) => c.ready);
    this.sendJson(res, 200, {
      ok: true,
      siteName: this.config.siteName,
      gameName: this.config.gameName,
      provider: readyChannels.length ? readyChannels[0].provider : (this.config.provider || 'sandbox'),
      providerReady: readyChannels.length > 0,
      channels,
      packages: this.config.packages.map((p) => ({
        id: String(p.id),
        name: String(p.name || ''),
        rmb: money(p.rmb),
        dianka: Math.floor(money(p.dianka)),
        bonus: Math.floor(money(p.bonus)),
        tag: String(p.tag || ''),
      })),
      user,
    });
  }

  async apiLogin(req, res) {
    const body = await this.readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) {
      throw new HttpError(400, '请输入账号和密码');
    }
    if (username.length > 64 || password.length > 128) {
      throw new HttpError(400, '账号或密码过长');
    }

    const ip = this.clientIp(req);
    const rlKey = ip + '|' + username;
    const now = Date.now();
    const fail = this.loginFails.get(rlKey);
    if (fail && fail.until && fail.until > now) {
      throw new HttpError(429, '尝试次数过多，请 10 分钟后再试');
    }

    const db = this.opts.loadUsers();
    const user = db && db.users ? db.users[username] : null;
    let ok = false;
    if (user && user.salt && user.hash) {
      const hash = this.opts.hashPassword(password, user.salt);
      ok = safeEqual(hash, user.hash);
    } else {
      // 账号不存在时也做一次哈希，避免用响应时间探测账号
      this.opts.hashPassword(password, '0000000000000000');
    }

    if (!ok) {
      const count = ((fail && fail.count) || 0) + 1;
      this.loginFails.set(rlKey, {
        count,
        until: count >= 5 ? now + 10 * 60 * 1000 : 0,
      });
      throw new HttpError(401, '账号或密码错误');
    }

    this.loginFails.delete(rlKey);
    const sid = this.makeSession(user.userID, username);
    const hours = Number(this.config.sessionHours) > 0 ? Number(this.config.sessionHours) : 12;
    this.setCookie(req, res, 'pay_sid', sid, hours * 3600);
    this.sendJson(res, 200, { ok: true, user: this.userInfo({ u: user.userID, n: username }) });
  }

  apiLogout(req, res) {
    this.clearCookie(req, res, 'pay_sid');
    this.sendJson(res, 200, { ok: true });
  }

  apiPackages(req, res) {
    this.sendJson(res, 200, {
      ok: true,
      packages: this.config.packages.map((p) => ({
        id: String(p.id),
        name: String(p.name || ''),
        rmb: money(p.rmb),
        dianka: Math.floor(money(p.dianka)),
        bonus: Math.floor(money(p.bonus)),
        tag: String(p.tag || ''),
      })),
    });
  }

  apiOrders(req, res) {
    const session = this.readSession(req);
    const found = this.findUserRecord(session);
    if (!found) throw new HttpError(401, '请先登录');
    const list = Object.values(this.state.orders)
      .filter((o) => o && o.userID === found.user.userID)
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .slice(0, 10)
      .map((o) => this.orderPublic(o));
    this.sendJson(res, 200, { ok: true, orders: list });
  }

  async apiCreateOrder(req, res) {
    const session = this.readSession(req);
    const found = this.findUserRecord(session);
    if (!found) throw new HttpError(401, '请先登录');

    const body = await this.readJson(req);
    const packageId = String(body.packageId || '');
    const channel = String(body.channel || '');
    const pkg = this.findPackage(packageId);
    const pkgErr = this.validatePackage(pkg);
    if (pkgErr) throw new HttpError(400, pkgErr);
    if (!CHANNELS.some((c) => c.id === channel)) throw new HttpError(400, '请选择支付方式');
    const provider = this.providerForChannel(channel);
    if (!provider) throw new HttpError(400, '该支付方式暂未开通');
    if (!this.providerReadyFor(channel)) throw new HttpError(503, '支付通道尚未配置，请联系管理员');
    this.expireStaleOrders();

    // 防止刷单：1 分钟内最多 10 个待支付订单，累计最多 30 个
    const now0 = Date.now();
    let pendingCount = 0;
    let recentCount = 0;
    for (const o of Object.values(this.state.orders)) {
      if (!o || o.userID !== found.user.userID || o.status !== 'pending') continue;
      pendingCount++;
      if (Number(o.createdAt) > now0 - 60 * 1000) recentCount++;
    }
    if (recentCount >= 10 || pendingCount >= 30) {
      throw new HttpError(429, '下单过于频繁，请稍后再试');
    }

    const save = this.opts.readSave(found.user.userID) || null;
    const baseDianka = save ? Math.max(0, Math.floor(Number(save.dianka) || 0)) : 0;
    const now = Date.now();
    const minutes = Number(this.config.orderExpireMinutes) > 0 ? Number(this.config.orderExpireMinutes) : 30;

    const order = {
      orderNo: this.newOrderNo(),
      userID: found.user.userID,
      username: found.username,
      packageId: String(pkg.id),
      packageName: String(pkg.name || ('充值 ' + money(pkg.rmb) + ' 元')),
      rmb: money(pkg.rmb),
      dianka: Math.floor(money(pkg.dianka)),
      bonus: Math.floor(money(pkg.bonus)),
      channel,
      status: 'pending',
      createdAt: now,
      expiresAt: now + minutes * 60 * 1000,
      baseDianka,
      tradeNo: '',
      paidAt: 0,
      claimed: false,
      claimedAt: 0,
      provider,
      ip: this.clientIp(req),
    };
    this.state.orders[order.orderNo] = order;
    this.saveState();
    this.cleanupOrders();

    const payUrl = this.buildPayUrl(order, req);
    console.log(
      '[pay] 创建订单', order.orderNo,
      '账号=' + order.username,
      '套餐=' + order.packageName,
      '金额=' + order.rmb.toFixed(2),
      '点卡=' + order.dianka,
      '通道=' + channel
    );
    return this.sendJson(res, 200, {
      ok: true,
      orderNo: order.orderNo,
      payUrl,
      rmb: order.rmb,
      dianka: order.dianka,
      channel,
    });
  }

  apiOrderStatus(req, res, url) {
    const no = String(url.searchParams.get('no') || url.searchParams.get('orderNo') || '');
    const order = this.state.orders[no];
    if (!order) throw new HttpError(404, '订单不存在');
    this.maybeExpire(order);
    this.sendJson(res, 200, { ok: true, order: this.orderPublic(order) });
  }

  /* ---------- 支付回调 ---------- */

  async notify(req, res, url) {
    if (!this.epayConfigured()) {
      return this.sendText(res, 404, 'Not Found');
    }
    const params = {};
    for (const [k, v] of url.searchParams) params[k] = v;
    if (req.method === 'POST') {
      const raw = await this.readBody(req, this.maxBodyBytes);
      if (raw.length) {
        const form = new URLSearchParams(raw.toString('utf8'));
        for (const [k, v] of form) params[k] = v;
      }
    }

    const sign = String(params.sign || '');
    if (!sign || !safeEqual(sign.toLowerCase(), this.epaySign(params))) {
      console.warn('[pay] 回调签名校验失败', JSON.stringify(params));
      return this.sendText(res, 400, 'sign error');
    }
    if (String(params.pid) !== String(this.config.epay.pid)) {
      console.warn('[pay] 回调 pid 不匹配', params.pid);
      return this.sendText(res, 400, 'pid error');
    }

    const no = String(params.out_trade_no || '');
    const order = this.state.orders[no];
    if (!order) {
      console.warn('[pay] 回调订单不存在', no);
      return this.sendText(res, 404, 'order not found');
    }
    if (money(params.money).toFixed(2) !== money(order.rmb).toFixed(2)) {
      console.warn('[pay] 回调金额不匹配', no, params.money, order.rmb);
      return this.sendText(res, 400, 'money error');
    }
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(String(params.trade_status))) {
      return this.sendText(res, 400, 'trade status error');
    }

    this.markOrderPaid(order, params.trade_no, 'epay');
    return this.sendText(res, 200, 'success');
  }

  /* ---------- 本地模拟支付（sandbox） ---------- */

  sandboxOrderFromPath(pathname) {
    const m = /^\/pay\/sandbox\/([^/]+)(\/pay)?$/.exec(pathname);
    if (!m) return null;
    return { orderNo: decodeURIComponent(m[1]), action: Boolean(m[2]) };
  }

  async sandbox(req, res, url) {
    const info = this.sandboxOrderFromPath(url.pathname);
    if (!info) return this.sendText(res, 404, 'Not Found');
    const order = this.state.orders[info.orderNo];
    if (!order) return this.sendText(res, 404, '订单不存在');
    if (order.provider && order.provider !== 'sandbox') {
      return this.sendText(res, 404, '订单不存在');
    }
    this.maybeExpire(order);

    if (!info.action) {
      return this.sendHtml(res, 200, this.sandboxPage(order));
    }

    const result = String(url.searchParams.get('result') || 'success');
    if (result === 'success') {
      this.markOrderPaid(order, 'SANDBOX' + Date.now(), 'sandbox');
    } else if (order.status === 'pending') {
      order.status = 'closed';
      this.saveState();
    }
    res.writeHead(302, {
      Location: '/pay/return?order=' + encodeURIComponent(order.orderNo),
      'Cache-Control': 'no-store',
    });
    res.end();
  }

  sandboxPage(order) {
    const statusText = {
      pending: '等待支付',
      paid: '支付成功（待游戏内领取）',
      credited: '已到账',
      expired: '订单已过期',
      closed: '订单已关闭',
      failed: '支付失败',
    }[order.status] || order.status;
    const canPay = order.status === 'pending';
    const no = encodeURIComponent(order.orderNo);
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>模拟支付 - ' + escapeHtml(this.config.siteName) + '</title>' +
      '<style>' +
      'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;}' +
      '.card{width:min(420px,92vw);background:#161b22;border:1px solid #30363d;border-radius:16px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.5);}' +
      'h1{font-size:20px;margin:0 0 6px;}p{color:#8b949e;line-height:1.7;margin:6px 0;}' +
      '.amount{font-size:36px;font-weight:800;color:#f0b429;margin:18px 0 4px;}' +
      '.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid #21262d;font-size:14px;}' +
      '.row span:first-child{color:#8b949e}.row span:last-child{text-align:right;word-break:break-all;}' +
      '.btns{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;}' +
      'a.btn{flex:1;min-width:140px;text-align:center;text-decoration:none;padding:13px 16px;border-radius:10px;font-weight:700;}' +
      '.ok{background:#238636;color:#fff}.cancel{background:#21262d;color:#c9d1d9;border:1px solid #30363d}' +
      '.disabled{opacity:.5;pointer-events:none}' +
      '.tag{display:inline-block;margin-top:10px;padding:4px 10px;border-radius:999px;background:#1f6feb22;color:#58a6ff;font-size:12px;}' +
      '</style></head><body><div class="card">' +
      '<div class="tag">沙箱模拟支付</div>' +
      '<h1>' + escapeHtml(order.packageName) + '</h1>' +
      '<div class="amount">¥' + money(order.rmb).toFixed(2) + '</div>' +
      '<p>支付后到账 <b style="color:#f0b429">' + Math.floor(money(order.dianka)) + '</b> 点卡</p>' +
      '<div class="row"><span>订单号</span><span>' + escapeHtml(order.orderNo) + '</span></div>' +
      '<div class="row"><span>游戏账号</span><span>' + escapeHtml(order.username) + '</span></div>' +
      '<div class="row"><span>支付方式</span><span>' + (order.channel === 'alipay' ? '支付宝' : '微信支付') + '</span></div>' +
      '<div class="row"><span>状态</span><span>' + escapeHtml(statusText) + '</span></div>' +
      '<div class="btns">' +
      '<a class="btn ok' + (canPay ? '' : ' disabled') + '" href="/pay/sandbox/' + no + '/pay?result=success">模拟支付成功</a>' +
      '<a class="btn cancel" href="/pay/sandbox/' + no + '/pay?result=cancel">取消支付</a>' +
      '</div>' +
      '<p style="margin-top:18px;font-size:12px;color:#6e7681;">这是本地测试页面，正式环境请在 pay-config.json 把 provider 改为 epay 并配置支付平台参数。</p>' +
      '</div></body></html>';
  }
}

function createPayService(opts) {
  return new PayService(opts);
}

module.exports = { createPayService, PayService };
