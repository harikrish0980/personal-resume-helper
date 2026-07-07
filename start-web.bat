@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
set "APP_ROOT=%PROJECT_ROOT%personal-resume-helper-web"
if not defined RESUME_WORKSPACE_PATH set "RESUME_WORKSPACE_PATH=%PROJECT_ROOT%Resume-Workspace"
set "LEGACY_WORKSPACE_PATH=%PROJECT_ROOT%Career-Ops"
set "TEMPLATE_ROOT=%PROJECT_ROOT%templates\Resume-Workspace"
if not defined PORT set "PORT=3025"
if not defined GEMINI_MODEL set "GEMINI_MODEL=gemini-2.5-flash-lite"

set "NODE_EXE=node"

where "%NODE_EXE%" >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 20 or newer, then run this file again.
  echo https://nodejs.org/
  pause
  exit /b 1
)

if not exist "%APP_ROOT%\server.mjs" (
  echo Could not find the web app at:
  echo %APP_ROOT%
  echo Run this file from the project root folder.
  pause
  exit /b 1
)

if not exist "%RESUME_WORKSPACE_PATH%\" (
  if exist "%LEGACY_WORKSPACE_PATH%\" (
    echo Creating private Resume-Workspace from existing Career-Ops folder...
    xcopy "%LEGACY_WORKSPACE_PATH%" "%RESUME_WORKSPACE_PATH%" /E /I /Y >nul
  ) else if exist "%TEMPLATE_ROOT%\" (
    echo Creating private Resume-Workspace from templates...
    xcopy "%TEMPLATE_ROOT%" "%RESUME_WORKSPACE_PATH%" /E /I /Y >nul
  ) else (
    echo Missing private Resume-Workspace and template folder.
    echo Expected template:
    echo %TEMPLATE_ROOT%
    pause
    exit /b 1
  )
)

if not exist "%APP_ROOT%\.env" (
  if exist "%APP_ROOT%\.env.example" (
    echo Creating personal-resume-helper-web\.env from .env.example...
    copy "%APP_ROOT%\.env.example" "%APP_ROOT%\.env" >nul
    echo Add your GEMINI_API_KEY in personal-resume-helper-web\.env for AI evaluation.
  )
)

set "EXISTING_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:"127\.0\.0\.1:%PORT% .*LISTENING"') do set "EXISTING_PID=%%P"

if defined EXISTING_PID (
  echo Port %PORT% is already in use by process %EXISTING_PID%.
  set /p STOP_EXISTING="Stop it and start EaZy Job Apply from this folder? [Y/N] "
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
echo Starting EaZy Job Apply at http://127.0.0.1:%PORT%
start "" "http://127.0.0.1:%PORT%"
"%NODE_EXE%" server.mjs

echo.
echo Server stopped. Press any key to close this window.
pause >nul
