@echo off
rem Issues a FRESH laptop certificate and invalidates the old one immediately.
rem Use this if your laptop was lost, or to move access to a different laptop.
cd /d "%~dp0"
node server.js --enroll new
echo.
echo A new certificate folder was created in  data\enroll
echo Copy it to the laptop you want to use and run install-on-laptop.bat there.
echo The previous laptop can no longer connect.
start "" explorer.exe "%~dp0data\enroll"
pause
