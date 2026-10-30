@echo off
rem Stops PCRemote and removes its autostart task and firewall rule (keeps files and settings).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -NoExit -File ""%~dp0install.ps1"" -Uninstall'"
