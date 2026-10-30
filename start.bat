@echo off
rem Runs PCRemote in this window (handy for watching the log). Close the window to stop it.
cd /d "%~dp0"
title PC Remote
node server.js
pause
