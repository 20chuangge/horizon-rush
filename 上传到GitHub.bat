@echo off
chcp 65001 >nul
title HORIZON RUSH - Upload to GitHub
cd /d "%~dp0"
echo.
echo  ==================================================
echo   HORIZON RUSH - GitHub upload / Pages helper
echo  ==================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0upload-to-github.ps1"
if errorlevel 1 (
  echo.
  echo Script exited with an error.
  pause
)
