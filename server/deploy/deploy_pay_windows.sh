#!/usr/bin/env bash
# 在 Windows 本机 Git Bash 中执行，把充值系统部署到阿里云 ECS。
#
# 前提：
#   1. 阿里云安全组已放行 22/TCP（对你的当前公网 IP）
#   2. 本机 ~/.ssh/id_ed25519_sanguo 已加入服务器 root 的 authorized_keys
#   3. 服务器上已有 /opt/sanguo，systemd 服务名为 sanguo-server
#
# 用法：
#   bash server/deploy/deploy_pay_windows.sh
#
# 可用环境变量覆盖：
#   HOST=47.117.160.225 SSH_USER=root SSH_PORT=22 SSH_KEY=~/.ssh/id_ed25519_sanguo
#   REMOTE_DIR=/opt/sanguo
#   PRIVATE_KEY_SRC="..." CERT_DIR="/d/支付宝公钥"
set -euo pipefail

HOST="${HOST:-47.117.160.225}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_sanguo}"
REMOTE_DIR="${REMOTE_DIR:-/opt/sanguo}"
SERVICE="${SERVICE:-sanguo-server}"

LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PRIVATE_KEY_SRC="${PRIVATE_KEY_SRC:-/c/Users/82044/Documents/支付宝开放平台密钥工具/证书20261116130547/应用私钥RSA2048-敏感数据，请妥善保管.txt}"
CERT_DIR="${CERT_DIR:-/d/支付宝公钥}"
APP_ID="2021005194603387"

SSH=(ssh -i "$SSH_KEY" -p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new)
SCP=(scp -i "$SSH_KEY" -P "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new)

log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy][error]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$SSH_KEY" ] || die "SSH 密钥不存在: $SSH_KEY"
[ -f "$PRIVATE_KEY_SRC" ] || die "应用私钥不存在: $PRIVATE_KEY_SRC"
[ -f "$CERT_DIR/appCertPublicKey_${APP_ID}.crt" ] || die "应用公钥证书不存在: $CERT_DIR/appCertPublicKey_${APP_ID}.crt"
[ -f "$CERT_DIR/alipayCertPublicKey_RSA2.crt" ] || die "支付宝公钥证书不存在"
[ -f "$CERT_DIR/alipayRootCert.crt" ] || die "支付宝根证书不存在"

log "检查 SSH 连接 $SSH_USER@$HOST:$SSH_PORT ..."
"${SSH[@]}" "$SSH_USER@$HOST" "echo connected; node -v; systemctl is-active $SERVICE" || die "SSH 连接失败。请确认阿里云安全组已放行 22/TCP，且授权对象包含当前公网 IP。"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "打包服务端文件（不包含 data/、mona/、日志）..."
tar czf "$TMP/server_pay.tgz" -C "$LOCAL_DIR" \
  server.js game.js pay.js pay-page.html config.json starter.json package.json \
  vendor tools README.md \
  -C "$LOCAL_DIR/.." shop.xml staticgeneral.xml stage.xml

log "生成云端专用 pay-config.json（证书路径改为 /opt/sanguo/certs）..."
node -e '
const fs = require("fs");
const [src, dst, host] = process.argv.slice(1);
const c = JSON.parse(fs.readFileSync(src, "utf8"));
c.baseUrl = "http://" + host + ":8080";
c.alipay.privateKeyPath = "/opt/sanguo/certs/app_private_key.txt";
c.alipay.appCertPath = "/opt/sanguo/certs/appCertPublicKey_2021005194603387.crt";
c.alipay.alipayCertPath = "/opt/sanguo/certs/alipayCertPublicKey_RSA2.crt";
c.alipay.alipayRootCertPath = "/opt/sanguo/certs/alipayRootCert.crt";
fs.writeFileSync(dst, JSON.stringify(c, null, 2) + "\n");
console.log("baseUrl =", c.baseUrl);
console.log("alipay.mode =", c.alipay.mode, "appId =", c.alipay.appId);
' "$LOCAL_DIR/pay-config.json" "$TMP/pay-config.server.json" "$HOST"

log "准备 ASCII 文件名的上传副本..."
cp "$PRIVATE_KEY_SRC" "$TMP/app_private_key.txt"
cp "$CERT_DIR/appCertPublicKey_${APP_ID}.crt" "$TMP/"
cp "$CERT_DIR/alipayCertPublicKey_RSA2.crt" "$TMP/"
cp "$CERT_DIR/alipayRootCert.crt" "$TMP/"

log "上传文件..."
"${SCP[@]}" \
  "$TMP/server_pay.tgz" \
  "$TMP/pay-config.server.json" \
  "$TMP/app_private_key.txt" \
  "$TMP/appCertPublicKey_${APP_ID}.crt" \
  "$TMP/alipayCertPublicKey_RSA2.crt" \
  "$TMP/alipayRootCert.crt" \
  "$SSH_USER@$HOST:/tmp/"

log "云端安装、设置权限、重启服务..."
"${SSH[@]}" "$SSH_USER@$HOST" bash -s <<REMOTE
set -euo pipefail
TS=\$(date +%Y%m%d-%H%M%S)
SERVICE_USER="\$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"
[ -n "\$SERVICE_USER" ] || SERVICE_USER=root
SERVICE_GROUP="\$(systemctl show -p Group --value "$SERVICE" 2>/dev/null || true)"
[ -n "\$SERVICE_GROUP" ] || SERVICE_GROUP="\$SERVICE_USER"
mkdir -p "$REMOTE_DIR/certs"
# 备份旧服务端（保留 data/mona）
tar czf "/opt/sanguo-backup-\$TS.tar.gz" -C "$REMOTE_DIR" --exclude=data --exclude=mona --exclude=certs . || true
# 解压新文件，不会删除 data/ 和 mona/
tar xzf /tmp/server_pay.tgz -C "$REMOTE_DIR"
cp /tmp/pay-config.server.json "$REMOTE_DIR/pay-config.json"
cp /tmp/app_private_key.txt "$REMOTE_DIR/certs/app_private_key.txt"
cp /tmp/appCertPublicKey_${APP_ID}.crt "$REMOTE_DIR/certs/"
cp /tmp/alipayCertPublicKey_RSA2.crt "$REMOTE_DIR/certs/"
cp /tmp/alipayRootCert.crt "$REMOTE_DIR/certs/"
# 证书只有运行服务的用户可读
chown -R "\$SERVICE_USER:\$SERVICE_GROUP" "$REMOTE_DIR" "$REMOTE_DIR/certs"
chmod 700 "$REMOTE_DIR/certs"
chmod 600 "$REMOTE_DIR/certs/"*
rm -f /tmp/server_pay.tgz /tmp/pay-config.server.json /tmp/app_private_key.txt \
      /tmp/appCertPublicKey_${APP_ID}.crt /tmp/alipayCertPublicKey_RSA2.crt /tmp/alipayRootCert.crt
systemctl restart "$SERVICE"
sleep 2
echo "--- service ---"
systemctl is-active "$SERVICE"
echo "--- health ---"
curl -sS http://127.0.0.1:8080/health; echo
echo "--- pay bootstrap ---"
curl -sS http://127.0.0.1:8080/pay/api/bootstrap | head -c 1200; echo
REMOTE

log "验证公网访问..."
curl -sS -m 8 -o /dev/null -w "公网 /pay: HTTP %{http_code}\n" "http://$HOST:8080/pay" || true
curl -sS -m 8 "http://$HOST:8080/pay/api/bootstrap" | head -c 1200 || true
echo
log "部署完成。备份文件在服务器 /opt/sanguo-backup-*.tar.gz"
