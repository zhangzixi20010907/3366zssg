# 阿里云部署完整步骤

本文按当前项目结构编写：

```
3366战神三国带服务端/         客户端（分发给玩家）
  main.swf / main.exe / ui.swf / general.swf / fubenui.swf / game.xml ...
  server/                    服务端（只部署到 ECS，不分发给玩家）
```

---

## 0. 准备清单

- 阿里云 ECS 一台（推荐 2 核 2G 起，Ubuntu 22.04/24.04）
- 公网 IP 或已解析到 ECS 的域名
- 安全组放行：
  - `22/TCP`（SSH，建议限制来源 IP）
  - `8080/TCP`（HTTP 服务端；用 Nginx 时可改 80/443）
  - `1935/UDP`（RTMFP 对战，必须）
  - `1935/TCP`（MonaServer RTMP/RTMFP）
- 玩家电脑需要安装 **Adobe AIR 运行时**（main.exe 是 AIR 应用，不是独立绿色包）
- 中国大陆地域使用域名 + 80/443 需要 ICP 备案；**直接用公网 IP:8080 不需要备案**

### 安全组入方向规则（具体参数）

在 ECS 控制台 → 网络与安全 → 安全组 → 找到实例绑定的安全组 → 配置规则 → 入方向 → 手动添加，按下表填写。

**方案 A：不使用 Nginx，客户端直连 `IP:8080`**

| 授权策略 | 优先级 | 协议类型 | 端口范围 | 授权对象 | 描述 |
|---|---|---|---|---|---|
| 允许 | 1 | 自定义 TCP | `22/22` | `你的公网IP/32` | SSH 管理 |
| 允许 | 1 | 自定义 TCP | `8080/8080` | `0.0.0.0/0` | 游戏 HTTP |
| 允许 | 1 | 自定义 UDP | `1935/1935` | `0.0.0.0/0` | RTMFP 对战 |
| 允许 | 1 | 自定义 TCP | `1935/1935` | `0.0.0.0/0` | MonaServer TCP |

**方案 B：使用 Nginx（80/443）**

| 授权策略 | 优先级 | 协议类型 | 端口范围 | 授权对象 | 描述 |
|---|---|---|---|---|---|
| 允许 | 1 | 自定义 TCP | `22/22` | `你的公网IP/32` | SSH |
| 允许 | 1 | 自定义 TCP | `80/80` | `0.0.0.0/0` | HTTP |
| 允许 | 1 | 自定义 TCP | `443/443` | `0.0.0.0/0` | HTTPS |
| 允许 | 1 | 自定义 UDP | `1935/1935` | `0.0.0.0/0` | RTMFP |

> 用 Nginx 时 **不需要**对公网开放 8080，Nginx 在本机反代 `127.0.0.1:8080` 即可。

**Windows Server 额外规则**

| 授权策略 | 优先级 | 协议类型 | 端口范围 | 授权对象 | 描述 |
|---|---|---|---|---|---|
| 允许 | 1 | 自定义 TCP | `3389/3389` | `你的公网IP/32` | RDP 远程桌面 |

**可选规则**

| 授权策略 | 优先级 | 协议类型 | 端口范围 | 授权对象 | 描述 |
|---|---|---|---|---|---|
| 允许 | 1 | 全部 ICMP | `-1/-1` | `0.0.0.0/0` | 允许 ping |
| 允许 | 1 | 自定义 TCP | `8088/8088` | `你的公网IP/32` | MonaServer 管理页（不建议公网） |

**填写说明**

- **授权类型**：IPv4；如果要支持 IPv6，再对同样端口加一条 `::/0`
- **协议类型**：1935 必须同时加 **自定义 UDP** 和 **自定义 TCP**；RTMFP 只走 UDP，漏掉 UDP 会导致联机失败
- **端口范围**：单端口写 `8080/8080`，不要只写 `8080`
- **授权对象**：`0.0.0.0/0` 表示所有 IPv4；SSH/RDP 强烈建议改成你自己的公网 IP + `/32`
- **优先级**：数字越小越优先，统一用 1 即可；已有拒绝规则时注意不要冲突
- **生效**：保存后立即生效，不需要重启 ECS
- **多层防火墙**：安全组放行后，ECS 内部的 `ufw/firewalld` 或 Windows 防火墙也要放行（见第 4 节和 Windows 章节）
- **轻量应用服务器**：没有“安全组”，在控制台的“防火墙”里添加同样的端口规则

---

## 1. 购买并初始化 ECS

1. 阿里云控制台 → 云服务器 ECS → 创建实例
2. 镜像：Ubuntu 22.04 64 位
3. 公网 IP：勾选“分配公网 IPv4 地址”，带宽按人数选（测试 1~5 Mbps 足够）
4. 登录方式：SSH 密钥对（推荐）或设置 root 密码
5. 创建完成后，在安全组入方向添加第 0 节的端口规则

SSH 登录：

```bash
ssh root@你的公网IP
```

---

## 2. 安装 Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

---

## 3. 上传服务端

在**本地 Windows** 的 PowerShell 中（把 IP 换成你的）：

```powershell
scp -r "D:\三国Q战_关公来袭.0\3366战神三国\3366战神三国带服务端\server\*" root@你的公网IP:/opt/sanguo/
```

如果没有 scp，可以用 WinSCP 上传 `server` 目录内容到 `/opt/sanguo/`。

在 ECS 上创建运行用户并授权：

```bash
sudo useradd -r -s /usr/sbin/nologin sanguo || true
sudo chown -R sanguo:sanguo /opt/sanguo
sudo mkdir -p /opt/sanguo/data/saves
```

---

## 4. 启动并验证

```bash
cd /opt/sanguo
sudo -u sanguo node server.js
```

另开一个终端：

```bash
curl http://127.0.0.1:8080/health
# 应返回 {"ok":true,...}
```

再验证注册：

```bash
curl -X POST "http://127.0.0.1:8080/api?plain=1" \
  -H "Content-Type: application/json" \
  -d '{"head":9002,"username":"testuser","password":"123456"}'
```

成功后按 `Ctrl+C` 停止，注册 systemd 服务：

```bash
sudo cp /opt/sanguo/deploy/sanguo-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sanguo-server
sudo systemctl status sanguo-server
journalctl -u sanguo-server -f
```

确认外网可访问：

```bash
# 在你自己电脑上
curl http://ECS公网IP:8080/health
```

如果外网不通：先检查阿里云安全组，再检查 ECS 内部防火墙：

```bash
sudo ufw status
sudo ufw allow 8080/tcp
```

---

## 5. 部署 MonaServer（玩家间对战）

安装 Docker：

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

启动 MonaServer：

```bash
sudo docker run -d --name mona --restart unless-stopped \
  -p 1935:1935 -p 1935:1935/udp \
  -p 8088:80 \
  monaserver/monaserver
```

检查 UDP 端口：

```bash
sudo ss -lunp | grep 1935
```

安全组务必放行 `1935/UDP`。RTMFP 使用 UDP，只放 TCP 是连不上的。

> 如果使用 Windows Server，不要跑这个 Linux 镜像，改用 MonaServer 的 Windows 原生版（见 README 的 Windows 章节）。

---

## 6. 配置客户端

编辑客户端目录的 `game.xml`：

```xml
<server url="http://你的公网IP:8080/api" />
<rtmfp url="rtmfp://你的公网IP:1935/" key="mona" />
```

- 只做账号/存档，暂不做联机：`rtmfp` 可以留默认，联机连接失败时客户端状态面板点“返回”仍可进单机内容
- 客户端 `main.swf` 已经是服务端版本；同目录的 `main_server.swf` 是备份
- 不要把 `server/` 目录分发给玩家

测试流程：

1. 启动 `main.exe`
2. 注册账号 → 登录
3. 首次进入创建角色
4. 玩一会儿后退出，重新登录，确认角色和存档还在
5. 两台机器分别登录不同账号，进入联机对战，验证 PvP

---

## 7. 可选：域名 + Nginx + HTTPS

域名 A 记录解析到 ECS 公网 IP，然后：

```bash
sudo apt-get install -y nginx
sudo cp /opt/sanguo/deploy/nginx.conf.example /etc/nginx/sites-available/sanguo
sudo nano /etc/nginx/sites-available/sanguo   # 修改 server_name
sudo ln -s /etc/nginx/sites-available/sanguo /etc/nginx/sites-enabled/sanguo
sudo nginx -t && sudo systemctl reload nginx
```

客户端 `game.xml` 改成：

```xml
<server url="http://你的域名/api" />
```

需要 HTTPS 时：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

然后把客户端改成 `https://你的域名/api`。

> 中国大陆地域绑定域名并开放 80/443 需要 ICP 备案；没有备案时直接用 `IP:8080` 最简单。

---

## 8. 运维与备份

备份账号和存档：

```bash
sudo mkdir -p /opt/backup
sudo tar czf /opt/backup/sanguo-$(date +%F).tgz /opt/sanguo/data
```

建议加定时任务：

```bash
crontab -e
# 每天 4 点备份
0 4 * * * tar czf /opt/backup/sanguo-$(date +\%F).tgz /opt/sanguo/data
```

安全建议：

- 不要用 root 直接跑服务；本项目 systemd 使用 `sanguo` 用户
- SSH 使用密钥登录，限制 22 端口来源 IP
- 定期 `apt update && apt upgrade`
- 修改 `server/config.json` 后重启 `sanguo-server`
- 客户端里的 AES 密钥是公开的，不能当作安全边界；重要数据以服务端为准
- 定期清理/限制玩家存档大小（当前 `maxBodyBytes` 10MB）

---

## 9. 常见问题

| 现象 | 排查 |
|---|---|
| 客户端一直“请求超时” | `game.xml` 的 server url 是否改成公网 IP；ECS 8080 是否放行；`curl http://IP:8080/health` |
| 外网 curl 不通 | 阿里云安全组 + ECS `ufw/firewalld` 双层检查 |
| 登录成功但存档不保存 | 检查 `server/data/saves/` 是否有文件；服务端日志 |
| 联机一直“云端服务器连接失败” | 1935/UDP 是否放行；MonaServer 是否运行；`rtmfp` 地址是否正确 |
| 中文角色名乱码 | `game.xml` 保持 `requestCode=gbk`、`responseCode=utf-8` |
| 域名 80 打不开 | 大陆地域需要 ICP 备案；先用 IP:8080 |
| 玩家打不开 main.exe | 安装 Adobe AIR 运行时；或使用项目自带的 AIR 环境 |

---

## 10. Windows Server 简要步骤

1. ECS 选择 Windows Server 2022，RDP 登录
2. 安装 Node.js 20 LTS（Windows x64）
3. 把 `server` 目录放到 `C:\sanguo\server`
4. 管理员 PowerShell 运行 `server\deploy\windows\install-firewall.ps1`
5. `C:\sanguo\server\start.bat` 测试启动
6. 用 NSSM 注册 `SanguoServer` 服务（见 README）
7. 下载 MonaServer Windows 原生版，解压运行，放行 `1935/UDP`
8. `game.xml` 填公网 IP，客户端测试
