Option Explicit
Dim shell, args, command, i, code
Set args = WScript.Arguments
If args.Count < 3 Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
command = ""
For i = 0 To args.Count - 1
  If InStr(args(i), Chr(34)) > 0 Then WScript.Quit 2
  If i > 0 Then command = command & " "
  command = command & Chr(34) & args(i) & Chr(34)
Next
code = shell.Run(command, 0, True)
WScript.Quit code
