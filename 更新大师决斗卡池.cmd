@echo off
chcp 65001 >nul
cd /d "%~dp0"
node tools\update-master-duel-pool.mjs
echo.
pause
