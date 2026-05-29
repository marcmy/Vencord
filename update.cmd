@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\update-build-and-inject.ps1" %*
