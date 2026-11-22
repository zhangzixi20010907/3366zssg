# 手动部署新版服务端

适用：无法从本机 SSH 到 47.117.160.225（安全组未放行 22/TCP）时。

## 包内容

`sanguo-server-update-<时间戳>.tar.gz` 包含：

- `server.js`、`game.js`、`pay.js`、`pay-page.html`
- `config.json`、`starter.json`、`package.json`
- `vendor/`、`tools/`、`README.md`
- `shop.xml`、`staticgeneral.xml`、`stage.xml`

**不包含** `pay-config.json`、`data/`、`certs/`，覆盖时不会动线上的支付配置、订单和证书。

## 服务器上执行

把压缩包上传到服务器（例如 `/tmp/`），然后：

```bash
cd /opt/sanguo
tar xzf /tmp/sanguo-server-update-<时间戳>.tar.gz
systemctl restart sanguo-server
sleep 2
systemctl is-active sanguo-server
curl -s http://127.0.0.1:8080/health; echo
curl -s http://127.0.0.1:8080/pay/api/bootstrap | head -c 300; echo
```

预期：

- `systemctl is-active` 输出 `active`
- `/health` 输出 `{"ok":true,...}`
- `/pay/api/bootstrap` 里 `"provider":"alipay"`、`"providerReady":true`

## 回滚

部署脚本/手动上传前建议先备份：

```bash
tar czf /opt/sanguo-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  -C /opt/sanguo --exclude=data --exclude=certs .
```

回滚时解压对应备份并重启 `sanguo-server`。
