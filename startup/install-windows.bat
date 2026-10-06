@echo off
REM Scout — Windows Task Scheduler installer
REM Starts the companion server automatically on login.

echo Scout Task Scheduler Installer
echo ================================

REM Find the server directory (one level up from this script, then into server/)
set "SCRIPT_DIR=%~dp0"
set "SERVER_DIR=%SCRIPT_DIR%..\server"

REM Verify node exists
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Error: node not found. Install Node.js first.
    exit /b 1
)

for /f "tokens=*" %%i in ('where node') do set "NODE_PATH=%%i"

echo Server dir:  %SERVER_DIR%
echo Node:        %NODE_PATH%
echo.

REM Create log directory
if not exist "%USERPROFILE%\.scout" mkdir "%USERPROFILE%\.scout"

REM Remove existing task if present
schtasks /query /tn "Scout Server" >nul 2>&1
if %errorlevel% equ 0 (
    echo Removing existing Scout task...
    schtasks /delete /tn "Scout Server" /f >nul 2>&1
)

REM Create scheduled task that runs on login
schtasks /create ^
    /tn "Scout Server" ^
    /tr "\"%NODE_PATH%\" \"%SERVER_DIR%\index.js\"" ^
    /sc onlogon ^
    /rl limited ^
    /f

if %errorlevel% equ 0 (
    echo.
    echo Scout is now set to start on login.
    echo.
    echo Commands:
    echo   Stop:    schtasks /end /tn "Scout Server"
    echo   Start:   schtasks /run /tn "Scout Server"
    echo   Remove:  schtasks /delete /tn "Scout Server" /f
    echo   Status:  start http://localhost:8765/dashboard
) else (
    echo.
    echo Failed to create scheduled task. Try running as Administrator.
)

pause
