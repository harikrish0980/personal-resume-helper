@echo off
setlocal

set "APP_ROOT=%~dp0career-ops-web"
set "CAREER_OPS_PATH=%~dp0Career-Ops"
set "PORT=3013"
if not defined GEMINI_MODEL set "GEMINI_MODEL=gemini-2.5-flash-lite"

set "NODE_EXE=C:\Users\harik\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

cd /d "%APP_ROOT%"
start "" "http://localhost:%PORT%"
"%NODE_EXE%" server.mjs

echo.
echo Server stopped. Press any key to close this window.
pause >nul
