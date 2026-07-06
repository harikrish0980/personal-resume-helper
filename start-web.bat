@echo off
setlocal

set "APP_ROOT=%~dp0career-ops-web"
set "CAREER_OPS_PATH=%~dp0Career-Ops"
set "PORT=3013"
if not defined GEMINI_MODEL set "GEMINI_MODEL=gemini-2.5-flash-lite"

set "NODE_EXE=node"

set "EXISTING_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:"127\.0\.0\.1:%PORT% .*LISTENING"') do set "EXISTING_PID=%%P"

if defined EXISTING_PID (
  echo Port %PORT% is already in use by process %EXISTING_PID%.
  set /p STOP_EXISTING="Stop it and start the latest EaZy Job Apply app from this folder? [Y/N] "
  if /I "%STOP_EXISTING%"=="Y" (
    powershell -NoProfile -Command "Stop-Process -Id %EXISTING_PID% -Force"
    timeout /t 1 /nobreak >nul
  ) else (
    echo Keeping existing server. Opening the current app URL.
    start "" "http://127.0.0.1:%PORT%"
    exit /b 0
  )
)

cd /d "%APP_ROOT%"
start "" "http://127.0.0.1:%PORT%"
"%NODE_EXE%" server.mjs

echo.
echo Server stopped. Press any key to close this window.
pause >nul
