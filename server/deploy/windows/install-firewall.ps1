# 以管理员身份运行
# 放行 HTTP 服务端与 MonaServer RTMFP/RTMP 端口
New-NetFirewallRule -DisplayName "Sanguo HTTP"  -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Sanguo RTMFP" -Direction Inbound -Protocol UDP -LocalPort 1935 -Action Allow -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Sanguo RTMP"  -Direction Inbound -Protocol TCP -LocalPort 1935 -Action Allow -ErrorAction SilentlyContinue
Write-Host "Firewall rules ready: TCP 8080, UDP 1935, TCP 1935"
