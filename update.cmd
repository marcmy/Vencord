@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\update-build-and-inject.ps1" %*
set "updateExitCode=%ERRORLEVEL%"

echo.
if "%updateExitCode%"=="0" (
    echo Vencord update finished successfully.
) else (
    echo Vencord update failed with exit code %updateExitCode%.
)

pause
exit /b %updateExitCode%
