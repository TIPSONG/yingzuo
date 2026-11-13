@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Please install Node.js 22.12+ and run npm ci, then npm run desktop.
  pause
  exit /b 1
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop\main.cjs"
