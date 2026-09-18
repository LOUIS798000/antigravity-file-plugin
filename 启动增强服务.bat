@echo off
chcp 65001 >nul
title Antigravity 文件拖拽增强服务
cd /d "%~dp0"
echo 正在启动 Antigravity 文件拖拽增强服务...
node daemon.js
pause
