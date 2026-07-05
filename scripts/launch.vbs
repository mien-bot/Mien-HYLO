Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)
WshShell.CurrentDirectory = projectRoot
WshShell.Run """C:\Program Files\nodejs\npm.cmd"" run dev", 0, False
