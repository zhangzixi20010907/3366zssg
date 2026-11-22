# 战神三国 / 三国Q战 服务端

兼容当前客户端的 HTTP 服务端，提供：

- 账号注册、登录（密码 scrypt 加盐哈希，Token 鉴权）
- 云存档（完整角色数据，15 秒自动上传，剧情节点也会上传）
- 角色创建（复用客户端原有创建角色流程）
- 玩家间对战：配合 MonaServer/Cumulus 的 RTMFP 服务，客户端通过 NetGroup + P2P 直连对战

> 说明：当前客户端已切换为**全服务端模式**——`AESController.test = false`，登录、商店、武将、副本、擂台、奖励等 HTTP_NEW_* 请求全部发到本服务端，由 `game.js` 统一处理并写回存档，不再使用客户端 Test 本地模拟。
>
> `Sanguo4399.DEBUG` 必须保持 **true**：它不是“离线模式”，而是独立客户端「开始游戏 / 联机对战」按钮使用登录后服务端存档 `_loginData` 的分支。改成 false 后这两个按钮会去找 4399 平台的 `serviceHold`，独立客户端里没有该对象，点击会没反应。

## 目录

```
server/
  server.js          HTTP 服务端（无第三方依赖）
  game.js            全服务端游戏逻辑（商店、武将、副本、擂台、奖励等）
  config.json        配置（端口、AES 密钥、数据目录等）
  pay.js             充值 / 订单 / 支付回调 / 点卡发放 / 支付宝自动补单
  pay-config.json    充值网站配置（套餐、支付通道、密钥）
  pay-page.html      充值网站页面（手机 / 电脑自适应）
  tools/             客户端补丁工具（改充值地址、让 10009 走服务端）
  vendor/            qrcode-generator.js（当面付二维码，MIT）
  starter.json       新角色初始存档模板
  package.json
  data/              运行时生成：账号、存档、payments.json 订单、meta.json
  deploy/            systemd / Nginx / MonaServer 部署文件
```

## 本地测试

```bash
cd server
node server.js
# 默认监听 0.0.0.0:8080
```

- 健康检查：`http://127.0.0.1:8080/health`
- 明文调试接口：`POST http://127.0.0.1:8080/api?plain=1`
  ```bash
  curl -X POST "http://127.0.0.1:8080/api?plain=1" -H "Content-Type: application/json" \
    -d '{"head":9002,"username":"test","password":"123456"}'
  ```

## 客户端配置

客户端 `main.swf` 已经是服务端版本，会读取同目录 `game.xml`：

```xml
<server url="http://127.0.0.1:8080/api" />
<rtmfp url="rtmfp://127.0.0.1:1935/" key="mona" />
```

- 把 `127.0.0.1` 改成你的阿里云公网 IP 或域名
- 启动 `main.exe` 后会先出现账号登录/注册界面
- 注册后进入游戏，首次会走原有创建角色面板

## 全服务端模式（客户端补丁）

`main.swf` 已打补丁：

| 类 | 字段 | 值 | 作用 |
|---|---|---|---|
| `game.Sanguo4399` | `DEBUG` | `true`（保持） | 登录后「开始游戏 / 联机对战」使用服务端存档 `_loginData` 进入游戏 |
| `com.iflashigame.controller.AESController` | `_test` | `false` | 所有 `HTTP_NEW_*` 请求都发到服务端，不再用 Test 本地模拟 |
| `com.iflashigame.controller.AESController` | `_debug` | `false` | 关闭客户端 trace |

`ui.swf` 已把主界面「新年奖励 / 领取补偿」按钮（charId 927）的三个放置记录加上 `alpha=0` 颜色变换：对象仍然存在（`Map.initView` 里 `getChildByName("_buchangBtn")` 不会拿到 null），但不可见。

> 不要用“替换成空白 Sprite”的方式隐藏：`Map.initView` 对 `_buchangBtn` 没有判空，替换成 0 帧 Sprite 会导致地图初始化中断、地图加载不出来。

原文件备份：

- `main.swf.bak-serveronly-<时间戳>` / `main.swf.bak-debugfalse-<时间戳>`
- `ui.swf.bak-original-<时间戳>`（原始）
- `ui.swf.bak-sprite1006-<时间戳>`（失败的空白 Sprite 版本，仅留档）

需要恢复时，把对应备份改回原名即可。

> 改完 `main.swf` / `ui.swf` 后需要重新启动 `main.exe`。
>
> **上线顺序**：先部署新版服务端（`server.js`、`game.js`、`shop.xml`、`staticgeneral.xml`、`stage.xml`），确认 `/health` 正常，再运行新客户端。否则商店、副本、武将等请求会返回“服务器未实现该协议”。
>
> **存档说明**：切换后游戏使用服务端账号存档。之前 `DEBUG=true` 离线模式下的本地 `data.json` 不会自动合并到服务器账号；如果登录后提示创建角色，说明该账号在服务端还没有角色。

### 导入旧离线存档

如果想把离线模式的进度带过来，先在游戏里注册账号，然后在服务端执行：

```bash
cd server
node tools/import_save.js --user 你的游戏账号 --file ../data.json
```

会覆盖该账号现有的服务端存档，执行前建议先备份 `data/saves/`。导入后重新登录游戏即可。

服务端 `game.js` 目前实现的 head（数值见 `game/model/Head.as`）：

| head | 功能 |
|---|---|
| 10001 / 10002 / 10003 | 普通 / 求贤 / 点卡招募 |
| 10004 / 10005 / 10006 / 10007 / 10020 | 武将升级、进化、克制进阶、天赋、属性重洗 |
| 10008 | 上阵武将 |
| 10009 | 领取充值点卡 |
| 10010 | 商城购买（银子 / 点卡 / 功勋 / 声望） |
| 10011 / 10012 | 关卡战斗结果、P2P 战斗结果 |
| 10013 / 10014 / 10015 | 使用道具、保存战斗历史、验证码奖励 |
| 10016~10019、10042~10045、10048~10053 | 副本次数、进入、结算、翻牌 |
| 10021 / 10022 / 10040 / 10041 / 10046 / 10047 | 活动奖励、补偿、领点卡、国庆、登录奖励、任务 |
| 10030~10039 | 擂台列表 / 守擂 / 攻擂 / 结算 |

> 副本次数与一次性领取标记保存在 `data/meta.json`，不会随客户端自动存档被覆盖。

## 充值系统

游戏内点击「充值」按钮 → 打开充值网站 → 选择套餐 → 微信 / 支付宝支付 → 返回游戏点击「商城」领取点卡。

### 文件

| 文件 | 作用 |
|---|---|
| `pay.js` | 充值网站、订单、支付回调、点卡发放 |
| `pay-config.json` | 充值套餐、支付通道、站点地址、会话密钥 |
| `pay-page.html` | 充值页面（自适应手机 / 电脑） |
| `tools/patch_client_pay.js` | 修改 `main.swf` 的充值地址，并把 head=10009 加入服务端转发 |
| `vendor/qrcode-generator.js` | 支付宝当面付二维码生成（MIT） |
| `data/payments.json` | 运行时生成的订单数据（勿删） |

### 玩家流程

1. 游戏内点击「充值」，会调用 `navigateToURL(Config.CHONGZHI, "_blank")` 打开充值网站。
2. 玩家用**游戏账号 / 密码**登录充值网站。
3. 选择套餐、微信或支付宝，创建订单并跳转支付。
4. 支付成功后，订单进入「已支付、待领取」状态。
5. 玩家返回游戏，点击「商城」按钮（触发 head=10009），服务端把点卡写入存档并返回最新余额。
6. 如果玩家没有点「商城」，**重新登录游戏**也会自动到账（登录时同样会结算待领取点卡）。

### 本地 / 测试环境（sandbox）

默认 `pay-config.json` 里 `provider` 是 `sandbox`，不接真实支付也能完整跑通流程：

```bash
cd server
node server.js
```

- 打开 `http://127.0.0.1:8080/pay`
- 用游戏账号登录 → 选择套餐 → 会进入「沙箱模拟支付」页面
- 点「模拟支付成功」→ 回到游戏点「商城」即可看到点卡到账
- 正式上线前务必把 `provider` 改成 `epay` 或你自己的支付实现

### 正式接入微信 / 支付宝（易支付）

> 如果只需要支付宝，并且已有支付宝开放平台商户资质，推荐直接使用下面的「支付宝官方直连（证书模式）」，费率更低、到账更直接，不需要易支付。

`pay.js` 内置了彩虹易支付 / 同类聚合支付的对接（`provider: "epay"`）。
这类平台同时提供微信和支付宝通道，适合个人 / 小团队服务器，不需要单独申请两套官方商户号。

在 `pay-config.json` 中修改：

```json
{
  "baseUrl": "https://pay.your-domain.com",
  "sessionSecret": "换成一段足够长的随机字符串",
  "provider": "epay",
  "epay": {
    "apiUrl": "https://你的易支付域名.com/submit.php",
    "pid": "你的商户ID",
    "key": "你的商户密钥",
    "channels": { "wechat": "wxpay", "alipay": "alipay" }
  }
}
```

要求：

- `baseUrl` 必须是**支付平台能访问到的公网地址**（IP 或域名），用于拼接 `notify_url` / `return_url`。
- 服务器 / 安全组 / 防火墙需允许支付平台访问 `/pay/notify`。
- 强烈建议用 HTTPS（Nginx 反向代理 + 证书），并把 `baseUrl` 写成 `https://...`。
- 支付平台后台的「异步通知地址」不需要手动填，下单时会自动带上 `notify_url`。

### 支付宝官方直连（证书模式，已内置）

`pay.js` 已内置 `provider: "alipay"`，使用支付宝开放平台**证书模式**。支持三种模式：

| `alipay.mode` | 接口 | 效果 |
|---|---|---|
| `page`（默认） | `alipay.trade.page.pay` | 跳转支付宝电脑网站收银台 |
| `wap` | `alipay.trade.wap.pay` | 手机网站支付 |
| `precreate` | `alipay.trade.precreate` | 页面显示支付宝扫码二维码 |

配置示例（`pay-config.json`）：

```json
"channelProviders": { "alipay": "alipay" },
"alipay": {
  "mode": "page",
  "appId": "202100xxxxxxxxxxxx",
  "pid": "2088xxxxxxxxxxxx",
  "gateway": "https://openapi.alipay.com/gateway.do",
  "signType": "RSA2",
  "privateKeyPath": "C:/路径/应用私钥.txt",
  "appCertPath": "C:/路径/appCertPublicKey_<APPID>.crt",
  "alipayCertPath": "C:/路径/alipayCertPublicKey_RSA2.crt",
  "alipayRootCertPath": "C:/路径/alipayRootCert.crt"
}
```

说明：

- `channelProviders` 存在时，只有明确映射的通道会启用。当前只映射了支付宝，微信会显示“暂未开通”。要启用微信，可加 `"wechat": "epay"` 并填好 `epay` 参数。
- 应用私钥支持密钥工具导出的**裸 base64**，也支持 PKCS#8 / PKCS#1 PEM。
- `appCertSn` / `alipayRootCertSn` 可留空，服务端会自动按支付宝官方 SDK 的算法计算。
- 支付宝异步通知地址自动使用 `baseUrl + /pay/alipay/notify`；`baseUrl` 必须是支付宝能访问到的公网地址。
- 服务端会校验 `app_id`、`seller_id`、`out_trade_no`、`total_amount`、`trade_status`，并用支付宝公钥证书做 RSA2 验签；重复通知是幂等的。
- 部署到其他机器时，把私钥和三个证书复制到服务器上的安全目录，并保证运行 Node 的账号有读取权限；不要把私钥放进公开目录。
- 如果支付宝返回“无权限使用接口”，检查开放平台是否签约了对应产品，或切换 `alipay.mode`。

> 微信官方直连（微信支付 APIv3）尚未内置；需要商户号、APIv3 密钥、商户证书，可以再扩展一个 provider。当前微信可通过易支付聚合通道接入。

### 修改套餐 / 价格

编辑 `pay-config.json` 的 `packages`，重启服务端生效：

```json
{ "id": "p30", "name": "300 点卡", "rmb": 30, "dianka": 320, "bonus": 20, "tag": "热销" }
```

- `rmb`：人民币金额
- `dianka`：实际到账点卡总数（**包含**赠送）
- `bonus`：仅用于页面展示「额外赠送多少」
- `tag`：角标，如「热销」「超值」，可以留空

### 客户端补丁

当前目录的 `main.swf` 已经打过补丁，原文件备份为 `main.swf.bak-pay-时间戳`。
补丁做两件事：

1. `Config.CHONGZHI`：`http://my.4399.com/pay.php?...` → `http://47.117.160.225:8080/pay`
2. `AESController.isServerHead` 增加 `10009`，让「领取点卡」请求真正发到服务端。

> 注意：`isServerHead` 的数组从 5 个元素变成 6 个后，必须同时把该方法体的 `maxStack` 从 5 提到 6。工具会自动处理；只加数组不改 `maxStack` 会导致游戏登录/注册闪退。

如果以后服务器公网地址 / 域名变化，重新执行：

```bash
cd server
node tools/patch_client_pay.js --swf ../main.swf --url http://新地址:8080/pay
```

工具会自动备份，并在结束时验证新地址、旧地址移除、10009 补丁三项是否成功。

> 改完 `main.swf` 后需要重新启动 `main.exe`。

### 服务端协议

| head | 用途 | 说明 |
|---|---|---|
| 10009 | 领取点卡 | 客户端点击商城 / 关闭剧情时调用；服务端结算已支付未领取的订单，返回 `{dianka}` |

存档里的 `dianka` 由服务端在领取时写入。存在待领取订单时，15 秒自动存档**不允许点卡下降**，避免客户端旧余额覆盖服务端余额。

### 支付安全

- 游戏客户端的 AES 密钥是公开的，不能作为支付安全依据；支付安全依靠：充值网站账号登录 + 支付平台 MD5 验签 + 服务端金额校验。
- 服务端会校验：签名、`pid`、订单号、金额、`trade_status`；重复回调是幂等的，不会重复发点卡。
- 正式环境用 `channelProviders` 给每个通道指定真实 provider；`sandbox` 只用于本地测试，未配置的通道会显示“暂未开通”。
- 定期备份 `data/`（账号、存档、`payments.json` 订单都在里面）。
- 不要把 `pay-config.json` 的 `epay.key`、`sessionSecret` 暴露给玩家。

### 常见问题

**点了充值没打开网站？**
- 确认当前运行的 `main.swf` 是打过补丁的版本，且 `pay-config.json` 的 `baseUrl` / 补丁里的地址能从玩家电脑访问。
- 浏览器被拦截弹窗时，允许 `main.exe` 打开浏览器。

**支付成功但游戏内没到账？**
- 先确认客户端是**全服务端模式**：`AESController.test` 必须为 `false`；否则商店 / 点卡等请求会在客户端本地模拟。
- 返回游戏点击「商城」；或退出重新登录。
- 服务端会忽略客户端上传的 dianka，旧余额 / 旧存档无法再覆盖充值点卡。
- 用订单号查询：`http://服务器:8080/pay/api/order?no=订单号`，状态应为 `paid` 或 `credited`。
- 服务端现在每 60 秒会主动向支付宝查询一次待支付订单，异步通知丢失也会自动补记为已支付（单次最多查 5 单）。
- 查看服务端控制台日志是否有 `[pay] 支付成功 ...`。

**易支付回调一直失败？**
- 检查 `epay.pid` / `epay.key` 是否与支付平台一致。
- 检查 `baseUrl` 是否是公网可访问地址，`/pay/notify` 是否能被支付平台访问。
- 支付平台签名算法为 `MD5`，参数按 key 升序拼接后追加密钥；本模块已按该规则实现。

## 阿里云部署

### 1. 安全组 / 防火墙

| 端口 | 协议 | 用途 |
|---|---|---|
| 8080 | TCP | HTTP 服务端（也可用 Nginx 反代到 80/443） |
| 1935 | UDP | RTMFP 对战（MonaServer） |
| 1935 | TCP | RTMFP/RTMP（MonaServer） |

### 2. 安装 Node.js 并启动

Ubuntu 22.04/24.04：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo useradd -r -s /usr/sbin/nologin sanguo || true
sudo mkdir -p /opt/sanguo && sudo cp -r server/* /opt/sanguo/
sudo chown -R sanguo:sanguo /opt/sanguo
sudo cp /opt/sanguo/deploy/sanguo-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sanguo-server
sudo systemctl status sanguo-server
```

查看日志：`journalctl -u sanguo-server -f`

### 3. Nginx 反向代理（可选，推荐）

```bash
sudo apt-get install -y nginx
sudo cp /opt/sanguo/deploy/nginx.conf.example /etc/nginx/sites-available/sanguo
sudo ln -s /etc/nginx/sites-available/sanguo /etc/nginx/sites-enabled/sanguo
sudo nginx -t && sudo systemctl reload nginx
```

然后把 `game.xml` 的 `server url` 改成 `http://你的域名/api`。

### 4. 对战服务器（MonaServer，Docker）

```bash
docker run -d --name mona --restart unless-stopped \
  -p 1935:1935 -p 1935:1935/udp \
  -p 8088:80 \
  monaserver/monaserver
```

然后把 `game.xml` 改成：

```xml
<rtmfp url="rtmfp://你的公网IP:1935/" key="mona" />
```

> RTMFP 走 UDP，务必在阿里云安全组放行 1935/UDP。MonaServer 的 NetGroup/P2P 能力用于客户端现有的联机大厅与对战直连。

## Windows Server 部署

HTTP 服务端（Node.js）可以直接运行在 Windows Server 2019/2022 上，不需要 Linux。

### 1. 安装 Node.js

到 <https://nodejs.org/> 下载 **Windows x64 LTS**（建议 20.x）并安装，装完在 CMD 验证：

```bat
node -v
```

### 2. 启动服务端

把 `server/` 目录放到例如 `C:\sanguo\server`，双击 `start.bat`，或：

```bat
cd /d C:\sanguo\server
node server.js
```

看到 `[sanguo-server] listening on http://0.0.0.0:8080` 即成功。

### 3. Windows 防火墙

以管理员身份运行 PowerShell：

```powershell
New-NetFirewallRule -DisplayName "Sanguo HTTP"  -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
New-NetFirewallRule -DisplayName "Sanguo RTMFP" -Direction Inbound -Protocol UDP -LocalPort 1935 -Action Allow
New-NetFirewallRule -DisplayName "Sanguo RTMP"  -Direction Inbound -Protocol TCP -LocalPort 1935 -Action Allow
```

阿里云安全组同样要放行 `8080/TCP`、`1935/UDP`、`1935/TCP`。

### 4. 开机自启（二选一）

**方式 A：NSSM（推荐，作为 Windows 服务运行）**

1. 下载 [NSSM](https://nssm.cc/download)，解压出 `nssm.exe`
2. 管理员 CMD：

```bat
nssm install SanguoServer "C:\Program Files\nodejs\node.exe" "C:\sanguo\server\server.js"
nssm set SanguoServer AppDirectory "C:\sanguo\server"
nssm set SanguoServer AppStdout "C:\sanguo\server\server.log"
nssm set SanguoServer AppStderr "C:\sanguo\server\server-error.log"
nssm start SanguoServer
```

**方式 B：任务计划程序**

```bat
schtasks /create /tn "SanguoServer" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\sanguo\server\server.js\"" /sc onstart /ru SYSTEM
```

### 5. 对战服务器 MonaServer（Windows 原生）

Windows Server 上不建议跑 `monaserver/monaserver` 这个 Linux Docker 镜像（需要 WSL2/Hyper-V Linux 容器，成本和兼容性都差）。直接使用 MonaServer 的 Windows 版本：

1. 从 <https://www.monaserver.ovh/> 或 GitHub Releases 下载 Windows 版 MonaServer
2. 解压到例如 `C:\sanguo\mona`
3. 运行 `MonaServer.exe`（首次运行会生成 `MonaServer.ini`）
4. 确保 RTMFP 端口 `1935/UDP` 已放行
5. 需要开机自启时，同样用 NSSM 把它注册成服务

然后修改客户端 `game.xml`：

```xml
<server url="http://你的公网IP:8080/api" />
<rtmfp url="rtmfp://你的公网IP:1935/" key="mona" />
```

### Windows 注意事项

- 不要把 Node 服务端跑在 Administrator 交互式桌面会话里，建议用 NSSM 服务或任务计划（SYSTEM/专用账号）
- 目录不要放在 `C:\Program Files` 下（写存档可能受 UAC/权限限制），推荐 `C:\sanguo`
- 备份 `C:\sanguo\server\data\` 即可保存所有账号和存档
- 修改 `game.xml` 后重启 `main.exe` 生效

## 协议

客户端使用 AES-128-CBC + Base64：

- Key（ASCII）：`f5b7e8b70048457f`
- IV（ASCII）：`9fdf3dc3b9f26c42`
- 请求：`POST` 表单 `data=<Base64>`，明文 JSON 编码为 **GBK**
- 响应：纯文本 Base64，明文 JSON 编码为 **UTF-8**，必须回传请求里的 `stamp`

已实现 head：

| head | 用途 | 主要字段 |
|---|---|---|
| 9001 | 登录 | username, password |
| 9002 | 注册 | username, password |
| 9003 | 云存档 | token, data |
| 10000 | 创建角色 | token, roleName, imageID |
| 9999 | 兼容旧登录 | token 或 userID+password |

## 存档与安全

- 账号：`data/users.json`；存档：`data/saves/<userID>.json`
- 密码使用 scrypt + 随机盐，不保存明文
- Token 每次登录重新生成
- 定期备份整个 `data/` 目录
- `starter.json` 是新角色模板，可自行调整初始等级、银两、武将、背包等
- 若需要更强安全性，把 `game.xml` 换成 HTTPS，并在 Nginx 配置证书；同时同步修改客户端 AES 密钥配置（否则密钥公开在客户端中，仅能防篡改，不能防逆向）
