Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptDir)

Set shortcut = WshShell.CreateShortcut(WshShell.SpecialFolders("Desktop") & "\Mien.lnk")
shortcut.TargetPath = "wscript.exe"
shortcut.Arguments = """" & scriptDir & "\launch.vbs"""
shortcut.WorkingDirectory = projectRoot
shortcut.IconLocation = projectRoot & "\resources\icon.ico, 0"
shortcut.Description = "Mien - Personal Intelligence Dashboard"
shortcut.WindowStyle = 7
shortcut.Save
WScript.Echo "Shortcut created on Desktop with noodle icon"
