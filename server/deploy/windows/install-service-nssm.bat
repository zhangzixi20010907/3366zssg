@echo off
REM 以管理员身份运行；把路径改成你的实际目录
REM 需要先下载 nssm.exe 并放到 PATH 或当前目录
set SERVER_DIR=C:\sanguo\server
set NODE_EXE=C:\Program Files\nodejs\node.exe

nssm install SanguoServer "%NODE_EXE%" "%SERVER_DIR%\server.js"
nssm set SanguoServer AppDirectory "%SERVER_DIR%"
nssm set SanguoServer AppStdout "%SERVER_DIR%\server.log"
nssm set SanguoServer AppStderr "%SERVER_DIR%\server-error.log"
nssm start SanguoServer
echo SanguoServer service installed.
pause
