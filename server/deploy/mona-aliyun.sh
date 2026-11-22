#!/usr/bin/env bash
# ============================================================
# MonaServer（RTMFP 联机 / 聊天服务器）一键部署脚本
# 目标系统：Ubuntu 20.04 / 22.04 / 24.04
# 用法（在阿里云服务器上以 root 执行）：
#   sudo bash mona-aliyun.sh
# ============================================================
set -euo pipefail

log() { echo -e "\033[1;32m[mona]\033[0m $*"; }
warn() { echo -e "\033[1;33m[mona][warn]\033[0m $*"; }
die() { echo -e "\033[1;31m[mona][error]\033[0m $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "请用 root 运行：sudo bash $0"

export DEBIAN_FRONTEND=noninteractive

# ---------- 1. 安装 Docker ----------
if ! command -v docker >/dev/null 2>&1; then
  log "安装 Docker (docker.io) ..."
  apt-get update -y
  apt-get install -y docker.io ca-certificates curl
  systemctl enable --now docker
else
  log "Docker 已安装：$(docker --version)"
  systemctl is-active --quiet docker || systemctl start docker
fi

# ---------- 2. 配置国内镜像加速（拉取失败时更稳） ----------
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://dockerproxy.com"
  ]
}
EOF
  log "已写入 /etc/docker/daemon.json 镜像加速配置"
  systemctl restart docker
fi

# ---------- 3. 启动 MonaServer ----------
IMAGE="monaserver/monaserver"
log "拉取镜像 $IMAGE ..."
if ! docker pull "$IMAGE"; then
  die "镜像拉取失败。请检查服务器网络，或改用其它镜像源后重试。"
fi

# 清理同名旧容器（幂等）
docker rm -f mona >/dev/null 2>&1 || true

log "启动 MonaServer 容器 ..."
docker run -d --name mona --restart unless-stopped \
  -p 1935:1935 \
  -p 1935:1935/udp \
  -p 8088:80 \
  "$IMAGE"

# ---------- 4. 防火墙 ----------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "放行 ufw 端口 1935/tcp 1935/udp 8080/tcp ..."
  ufw allow 1935/tcp  >/dev/null 2>&1 || true
  ufw allow 1935/udp  >/dev/null 2>&1 || true
  ufw allow 8080/tcp  >/dev/null 2>&1 || true
else
  warn "ufw 未启用，跳过本机防火墙配置（仍需在阿里云安全组放行 1935/UDP）"
fi

# ---------- 5. 验证 ----------
sleep 2
log "容器状态："
docker ps --filter name=mona --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

log "监听端口："
ss -lunp 2>/dev/null | grep -E ':1935' || warn "未检测到 1935/UDP 监听，请查看 docker logs mona"

cat <<'TIP'

============================================================
部署完成后的最后一步（必须在阿里云控制台做，脚本无法代劳）：
  安全组 → 入方向 → 添加规则
    · 自定义 UDP  1935/1935  0.0.0.0/0   （RTMFP，必须！）
    · 自定义 TCP  1935/1935  0.0.0.0/0   （RTMP/RTMFP 握手）
    · 自定义 TCP  8080/8080  0.0.0.0/0   （HTTP 登录/存档）

客户端 game.xml 已经是：
  <rtmfp url="rtmfp://47.117.160.225:1935/" key="mona" />

外网验证（在你自己的电脑上）：
  curl http://47.117.160.225:8088/      # MonaServer 管理/HTTP
  然后启动 main.exe，登录后看是否还提示“云端服务器连接失败”

排查：
  docker logs -f mona
  ss -lunp | grep 1935
============================================================
TIP
