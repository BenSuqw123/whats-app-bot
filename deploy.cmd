@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 exit /b 2

rem Internal command worker streams output to the sanitizer. It never acquires a deploy lock.
if /I "%~1"=="--internal-run" goto INTERNAL_RUN

set "DEPLOY_EXIT=2"
set "DEPLOY_OWNS_LOCK=0"
set "DEPLOY_LOG="
set "DEPLOY_TOKEN="
set "DEPLOY_STAMP="
set "DEPLOY_NO_PAUSE=0"
if /I "%~1"=="--no-pause" set "DEPLOY_NO_PAUSE=1"
if not "%~1"=="" if /I not "%~1"=="--no-pause" goto BAD_ARGUMENT
if not "%~2"=="" goto BAD_ARGUMENT

echo ==================================================
echo        WHATSAPP BOT - PRODUCTION DEPLOY
echo ==================================================

where powershell.exe >nul 2>&1
if errorlevel 1 goto NO_POWERSHELL
if not exist "scripts\deploy-helper.ps1" goto NO_HELPER
mkdir ".deploy.lock" 2>nul
if errorlevel 1 goto LOCK_UNAVAILABLE
set "DEPLOY_OWNS_LOCK=1"
for /f %%T in ('powershell.exe -NoProfile -Command "[guid]::NewGuid().ToString('N')"') do set "DEPLOY_TOKEN=%%T"
if not defined DEPLOY_TOKEN goto PREFLIGHT_FAILED
if not exist "deploy-logs\" mkdir "deploy-logs"
if errorlevel 1 goto PREFLIGHT_FAILED
for /f %%T in ('powershell.exe -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss-fff"') do set "DEPLOY_STAMP=%%T"
if not defined DEPLOY_STAMP goto PREFLIGHT_FAILED
set "DEPLOY_LOG=%CD%\deploy-logs\deploy-%DEPLOY_STAMP%-%DEPLOY_TOKEN%.log"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\deploy-helper.ps1" -Mode Init -LogPath "%DEPLOY_LOG%"
if errorlevel 1 goto PREFLIGHT_FAILED

call :MESSAGE "[1/7] Pre-flight checks"
where node >nul 2>&1
if errorlevel 1 goto NO_NODE
where npm >nul 2>&1
if errorlevel 1 goto NO_NPM
where pm2 >nul 2>&1
if errorlevel 1 goto NO_PM2
if not exist "package.json" goto MISSING_FILES
if not exist "ecosystem.config.cjs" goto MISSING_FILES
if not exist "index.js" goto MISSING_FILES
if not exist "node_modules\" goto MISSING_DEPENDENCIES
call :RUN node-version Version
if errorlevel 1 goto PREFLIGHT_FAILED
call :RUN npm-version Version
if errorlevel 1 goto PREFLIGHT_FAILED
call :RUN pm2-version Version
if errorlevel 1 goto PREFLIGHT_FAILED
call :RUN config-check Check
if errorlevel 1 goto PREFLIGHT_FAILED

call :MESSAGE "[2/7] Running tests"
call :RUN test Test
if errorlevel 1 goto TESTS_FAILED
call :MESSAGE "TESTS PASSED"
call :MESSAGE "Proceeding with deployment..."

call :MESSAGE "[3/7] Inspecting current PM2 process"
call :RUN describe Describe
set "DEPLOY_DESCRIBE_EXIT=%errorlevel%"
rem Describe's nonzero result alone cannot distinguish missing app from a daemon error.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\deploy-helper.ps1" -Mode Inspect -LogPath "%DEPLOY_LOG%"
if errorlevel 4 goto FAILED
if errorlevel 3 goto FRESH_START
if errorlevel 1 goto FAILED
if not "%DEPLOY_DESCRIBE_EXIT%"=="0" goto FAILED

call :MESSAGE "[4/7] Stopping old process"
call :RUN stop Stop
if errorlevel 1 goto FAILED
call :RUN delete Delete
if errorlevel 1 goto FAILED
goto START_NEW

:FRESH_START
call :MESSAGE "No existing whatsappbot process found."
call :MESSAGE "Fresh deployment will be performed."
call :MESSAGE "[4/7] No old process to stop"

:START_NEW
call :MESSAGE "[5/7] Starting new version"
call :RUN start Start
if errorlevel 1 goto START_FAILED
call :RUN describe Describe
if errorlevel 1 goto START_FAILED
call :MESSAGE "[6/7] Verifying deployment"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\deploy-helper.ps1" -Mode Verify -LogPath "%DEPLOY_LOG%"
if errorlevel 1 goto FAILED
call :MESSAGE "[7/7] Saving PM2 state"
call :RUN save Save
if errorlevel 1 goto SAVE_WARNING
goto SUCCESS

:SAVE_WARNING
call :MESSAGE "WARNING: Bot is running, but PM2 process list could not be saved."

:SUCCESS
set "DEPLOY_EXIT=0"
call :DIAGNOSTICS
call :MESSAGE "=================================================="
call :MESSAGE "DEPLOY COMPLETED SUCCESSFULLY"
call :MESSAGE "PM2 online was verified; check WhatsApp readiness in the indicators below."
call :INDICATORS
goto CLEANUP

:START_FAILED
call :MESSAGE "New whatsappbot could not be started."
goto FAILED

:FAILED
set "DEPLOY_EXIT=1"
call :MESSAGE "=================================================="
call :MESSAGE "DEPLOY FAILED"
call :MESSAGE "Inspect PM2 and session ownership. No automatic rollback or restart loop was attempted."
call :DIAGNOSTICS
call :INDICATORS
goto CLEANUP

:TESTS_FAILED
call :MESSAGE "TESTS FAILED"
call :MESSAGE "DEPLOYMENT ABORTED"
goto PREFLIGHT_FAILED

:NO_NODE
call :MESSAGE "ERROR: Node.js is not available in PATH."
goto PREFLIGHT_FAILED
:NO_NPM
call :MESSAGE "ERROR: npm is not available in PATH."
goto PREFLIGHT_FAILED
:NO_PM2
call :MESSAGE "ERROR: PM2 is not available in PATH."
goto PREFLIGHT_FAILED
:MISSING_FILES
call :MESSAGE "ERROR: package.json, ecosystem.config.cjs or index.js is missing."
goto PREFLIGHT_FAILED
:MISSING_DEPENDENCIES
call :MESSAGE "Dependencies are missing. Run npm install first."
goto PREFLIGHT_FAILED
:PREFLIGHT_FAILED
set "DEPLOY_EXIT=2"
call :MESSAGE "DEPLOY ABORTED"
call :MESSAGE "Existing production bot was NOT stopped."
goto CLEANUP

:LOCK_UNAVAILABLE
echo Another deployment appears to be running, or the deploy lock cannot be created.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\deploy-helper.ps1" -Mode LockInfo
goto CLEANUP
:NO_POWERSHELL
echo ERROR: Windows PowerShell is missing. DEPLOY ABORTED.
goto CLEANUP
:NO_HELPER
echo ERROR: scripts\deploy-helper.ps1 is missing. DEPLOY ABORTED.
goto CLEANUP
:BAD_ARGUMENT
echo Usage: deploy.cmd [--no-pause]
goto CLEANUP

:CLEANUP
if not "%DEPLOY_OWNS_LOCK%"=="1" goto FINISH
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\deploy-helper.ps1" -Mode Cleanup -LogPath "%DEPLOY_LOG%"
if not errorlevel 1 goto FINISH
echo WARNING: Own deploy lock could not be cleaned. Inspect .deploy.lock before another deployment.
set "DEPLOY_EXIT=1"
:FINISH
if not "%DEPLOY_NO_PAUSE%"=="1" pause
exit /b %DEPLOY_EXIT%

:MESSAGE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\deploy-helper.ps1" -Mode Message -Text "%~1" -LogPath "%DEPLOY_LOG%"
exit /b 0

:RUN
rem The right-hand helper returns the worker's explicit final exit marker, NOT just pipeline success.
call "%~f0" --internal-run %1 2>&1 | powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\deploy-helper.ps1" -Mode Relay -Kind %2 -Text %1 -LogPath "%DEPLOY_LOG%"
exit /b %errorlevel%

:DIAGNOSTICS
call :RUN status Status
if errorlevel 1 call :MESSAGE "WARNING: PM2 status command failed."
call :RUN describe Describe
if errorlevel 1 call :MESSAGE "WARNING: PM2 describe command failed."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "scripts\deploy-helper.ps1" -Mode Inspect -LogPath "%DEPLOY_LOG%"
call :RUN logs Logs
if errorlevel 1 call :MESSAGE "WARNING: Recent PM2 logs could not be read."
exit /b 0

:INDICATORS
call :MESSAGE "Expected healthy indicators: connection-open, connection-stable, READY."
call :MESSAGE "Action required indicators: CONFLICT, AUTH_REQUIRES_ACTION, QR_REQUIRED, AUTH_REQUIRED."
call :MESSAGE "Do not repeatedly restart the bot. Inspect WhatsApp session/auth ownership first."
call :MESSAGE "Only safe status indicators are displayed; private message/QR/env output is filtered."
exit /b 0

:INTERNAL_RUN
if not "%DEPLOY_OWNS_LOCK%"=="1" exit /b 2
if not defined DEPLOY_TOKEN exit /b 2
if not exist ".deploy.lock\owner.json" exit /b 2
if /I "%~2"=="node-version" goto RUN_NODE_VERSION
if /I "%~2"=="npm-version" goto RUN_NPM_VERSION
if /I "%~2"=="pm2-version" goto RUN_PM2_VERSION
if /I "%~2"=="config-check" goto RUN_CONFIG_CHECK
if /I "%~2"=="test" goto RUN_TEST
if /I "%~2"=="describe" goto RUN_DESCRIBE
if /I "%~2"=="stop" goto RUN_STOP
if /I "%~2"=="delete" goto RUN_DELETE
if /I "%~2"=="start" goto RUN_START
if /I "%~2"=="save" goto RUN_SAVE
if /I "%~2"=="status" goto RUN_STATUS
if /I "%~2"=="logs" goto RUN_LOGS
exit /b 2
:RUN_NODE_VERSION
call node --version
goto WORKER_RESULT
:RUN_NPM_VERSION
call npm --version
goto WORKER_RESULT
:RUN_PM2_VERSION
call pm2 --version
goto WORKER_RESULT
:RUN_CONFIG_CHECK
call node --check ecosystem.config.cjs
goto WORKER_RESULT
:RUN_TEST
call npm test
goto WORKER_RESULT
:RUN_DESCRIBE
call pm2 describe whatsappbot
goto WORKER_RESULT
:RUN_STOP
call pm2 stop whatsappbot
goto WORKER_RESULT
:RUN_DELETE
call pm2 delete whatsappbot
goto WORKER_RESULT
:RUN_START
call pm2 start ecosystem.config.cjs
goto WORKER_RESULT
:RUN_SAVE
call pm2 save
goto WORKER_RESULT
:RUN_STATUS
call pm2 status
goto WORKER_RESULT
:RUN_LOGS
call pm2 logs whatsappbot --lines 100 --nostream
goto WORKER_RESULT
:WORKER_RESULT
set "DEPLOY_WORKER_EXIT=%errorlevel%"
echo __WHATSAPP_DEPLOY_EXIT__=%DEPLOY_WORKER_EXIT%
exit /b %DEPLOY_WORKER_EXIT%
