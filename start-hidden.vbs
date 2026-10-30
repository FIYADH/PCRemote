' Runs the PCRemote host with no console window, restarting it if it crashes.
' Exit code 3 means a setup problem (no password, port taken...) that a restart can't fix.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
Do
  code = sh.Run("node """ & dir & "\server.js""", 0, True)
  If code = 0 Or code = 3 Then Exit Do
  WScript.Sleep 3000
Loop
