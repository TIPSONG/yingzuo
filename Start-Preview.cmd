@echo off
setlocal
set "PREVIEW_PY=%LOCALAPPDATA%\Programs\Python\Python311\pythonw.exe"
if exist "%PREVIEW_PY%" (
  start "" "%PREVIEW_PY%" "%~dp0preview.py" --open
) else (
  start "" "%~dp0index.html"
)
endlocal
