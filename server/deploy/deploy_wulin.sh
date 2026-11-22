#!/usr/bin/env bash
# 部署「乌林遗迹」服务端改动：只更新 game.js + stage.xml，不碰 pay-config / data / mona。
#
# 前提：安全组放行 22/TCP，且本机 ~/.ssh/id_ed25519_sanguo 可登录 root@47.117.160.225
set -euo pipefail

HOST="${HOST:-47.117.160.225}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_sanguo}"
REMOTE_DIR="${REMOTE_DIR:-/opt/sanguo}"
SERVICE="${SERVICE:-sanguo-server}"

LOCAL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"   # 3366战神三国带服务端/
SERVER_DIR="$LOCAL_DIR/server"

SSH=(ssh -i "$SSH_KEY" -p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new)
SCP=(scp -i "$SSH_KEY" -P "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new)

log() { printf '\033[1;36m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy][error]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$SSH_KEY" ] || die "SSH 密钥不存在: $SSH_KEY"
[ -f "$SERVER_DIR/game.js" ] || die "缺少 $SERVER_DIR/game.js"
[ -f "$LOCAL_DIR/stage.xml" ] || die "缺少 $LOCAL_DIR/stage.xml"

log "检查 SSH 连接 $SSH_USER@$HOST:$SSH_PORT ..."
"${SSH[@]}" "$SSH_USER@$HOST" "echo connected; hostname; node -v; systemctl is-active $SERVICE" \
  || die "SSH 连接失败。请确认阿里云安全组已放行 22/TCP，且授权对象包含当前公网 IP。"

TS="$(date +%Y%m%d-%H%M%S)"
BK_GAME="game.js.bak-wulin-$TS"
BK_STAGE="stage.xml.bak-wulin-$TS"

log "上传 game.js / stage.xml 到 /tmp ..."
"${SCP[@]}" "$SERVER_DIR/game.js" "$SSH_USER@$HOST:/tmp/wulin-game.js"
"${SCP[@]}" "$LOCAL_DIR/stage.xml" "$SSH_USER@$HOST:/tmp/wulin-stage.xml"

log "云端备份、校验、替换、重启..."
"${SSH[@]}" "$SSH_USER@$HOST" bash -s -- "$REMOTE_DIR" "$SERVICE" "$BK_GAME" "$BK_STAGE" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"
SERVICE="$2"
BK_GAME="$3"
BK_STAGE="$4"

cd "$REMOTE_DIR"

# 记录运行用户，替换后保持属主
SERVICE_USER="$(systemctl show -p User --value "$SERVICE" 2>/dev/null || true)"
[ -n "$SERVICE_USER" ] || SERVICE_USER=root
SERVICE_GROUP="$(systemctl show -p Group --value "$SERVICE" 2>/dev/null || true)"
[ -n "$SERVICE_GROUP" ] || SERVICE_GROUP="$SERVICE_USER"

cp -p game.js "$BK_GAME"
cp -p stage.xml "$BK_STAGE"

cp /tmp/wulin-game.js ./game.js.new.js
cp /tmp/wulin-stage.xml ./stage.xml.new

echo "--- node --check new game.js ---"
node --check ./game.js.new.js

echo "--- 预检新 stage.xml part=12（不启动服务） ---"
rm -rf /tmp/sanguo-wulin-check /tmp/sanguo-wulin-check-root
mkdir -p /tmp/sanguo-wulin-check /tmp/sanguo-wulin-check-root
cp /tmp/wulin-stage.xml /tmp/sanguo-wulin-check-root/stage.xml
cp shop.xml staticgeneral.xml /tmp/sanguo-wulin-check-root/ 2>/dev/null || true
node -e '
const { createGameService } = require(process.argv[1] + "/game.js.new.js");
const s = createGameService({ rootDir: "/tmp/sanguo-wulin-check-root", dataDir: "/tmp/sanguo-wulin-check" });
const a = s.stages.byKey["12_1"];
const b = s.stages.byKey["12_10"];
if (!a || !b) { console.error("part 12 gates missing"); process.exit(1); }
console.log("part12 ok: 12_1 id=" + a.id + " name=" + a.name + " | 12_10 id=" + b.id + " name=" + b.name);
' "$REMOTE_DIR"

mv ./game.js.new.js ./game.js
mv ./stage.xml.new ./stage.xml
chown "$SERVICE_USER:$SERVICE_GROUP" game.js stage.xml

systemctl restart "$SERVICE"
sleep 2
if ! systemctl is-active --quiet "$SERVICE" || ! curl -sf -m 5 http://127.0.0.1:8080/health >/dev/null; then
   echo "部署后服务异常，自动回滚..."
   cp -p "$BK_GAME" game.js
   cp -p "$BK_STAGE" stage.xml
   systemctl restart "$SERVICE"
   exit 1
fi

echo "--- service ---"
systemctl is-active "$SERVICE"
echo "--- health ---"
curl -sS -m 5 http://127.0.0.1:8080/health; echo

echo "--- 运行中的服务加载 part12 校验 ---"
node -e '
const { createGameService } = require(process.argv[1] + "/game.js");
const s = createGameService({ rootDir: process.argv[1], dataDir: "/tmp/sanguo-wulin-check" });
const a = s.stages.byKey["12_1"]; const b = s.stages.byKey["12_10"];
if (!a || !b) { console.error("runtime part 12 missing"); process.exit(1); }
console.log("runtime part12 ok: " + a.name + " ... " + b.name);
' "$REMOTE_DIR"

echo "--- 文件 ---"
ls -la game.js stage.xml "$BK_GAME" "$BK_STAGE"
sha256sum game.js stage.xml
rm -f /tmp/wulin-game.js /tmp/wulin-stage.xml
REMOTE

log "验证公网 8080 ..."
curl -sS -m 8 -o /dev/null -w "公网 /health: HTTP %{http_code}\n" "http://$HOST:8080/health" || true
log "部署完成。备份: $REMOTE_DIR/$BK_GAME , $REMOTE_DIR/$BK_STAGE"
