@echo off
chcp 65001 >nul
title HORIZON RUSH - 极速地平线
echo.
echo   ============================================
echo    HORIZON RUSH - 极速地平线
echo    正在用默认浏览器打开游戏...
echo   ============================================
echo.
start "" "%~dp0index.html"
if errorlevel 1 (
  echo 无法自动打开浏览器，请手动双击 index.html
  pause
)
