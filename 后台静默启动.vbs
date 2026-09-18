Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeScript = scriptDir & "\daemon.js"

nodeExe = "node"
If fso.FileExists("D:\Program Files\nodejs\node.exe") Then
    nodeExe = "D:\Program Files\nodejs\node.exe"
ElseIf fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = "C:\Program Files\nodejs\node.exe"
ElseIf fso.FileExists("C:\Program Files (x86)\nodejs\node.exe") Then
    nodeExe = "C:\Program Files (x86)\nodejs\node.exe"
End If

Do
    exitCode = WshShell.Run("""" & nodeExe & """ """ & nodeScript & """", 0, True)
    WScript.Sleep 3000
Loop
