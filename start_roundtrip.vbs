' start_roundtrip.vbs  —  launches the Electron app with no terminal window.
' Double-click this file to open the roundtrip app silently.
Set sh = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = scriptDir & "\app"
' 0 = hidden window, False = don't wait for exit
sh.Run "cmd /c npm start", 0, False
