@echo off
rem Shows a USB drive plugged into the laptop as drive U: on this PC, over Tailscale (encrypted).
rem One-time laptop setup first: README, section "Use a laptop USB drive on the PC".
rem Windows asks for the LAPTOP's username and password the first time and can remember them.
setlocal
set "LAPTOP="
set /p LAPTOP=Laptop name in the Tailscale app (for example my-laptop):
if "%LAPTOP%"=="" exit /b 1
net use U: /delete /y >nul 2>&1
net use U: "\\%LAPTOP%\USB" /persistent:yes
if errorlevel 1 (
  echo.
  echo Could not reach the laptop's USB drive. Check that the laptop is on, Tailscale is
  echo connected on both devices, the drive is plugged in, and it is shared as "USB".
) else (
  echo.
  echo The laptop's USB drive is now drive U: on this PC.
  start "" explorer.exe U:\
)
pause
