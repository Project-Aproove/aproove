'-----------------------------------------------------------------
' BBrain — Auto-start no boot do Windows
' Coloque um atalho deste arquivo em:
'   shell:startup  (Win + R → digitar "shell:startup" → Enter)
'-----------------------------------------------------------------

Set WshShell = CreateObject("WScript.Shell")

' Abre o BBrain público direto no Chrome (funciona em qualquer computador)
WshShell.Run "https://bbrain-aproove.onrender.com/laboratorio", 1, False
