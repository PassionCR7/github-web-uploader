@echo off
chcp 65001 >nul
title GitHub 上传 Agent
cd /d "%~dp0"

echo.
echo   正在启动 GitHub 上传 Agent...
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   [错误] 没有检测到 Node.js，请先安装：https://nodejs.org/
    echo.
    pause
    exit /b 1
)

node server.js
echo.
echo   服务已停止。
pause