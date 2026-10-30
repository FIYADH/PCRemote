@echo off
rem Changes the password. Every remembered laptop is signed out and must enter the new one.
cd /d "%~dp0"
node server.js --set-password
pause
