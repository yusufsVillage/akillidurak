@echo off
rem Durak Ops'u bu bilgisayarda calistirir. PythonAnywhere'de kullanilmaz, zip'e girmez.
chcp 65001 >nul
cd /d "%~dp0"
set "VENV_PY=.venv\Scripts\python.exe"

if not exist "%VENV_PY%" (
  echo Ilk calistirma: Python sanal ortami hazirlaniyor...
  python -m venv .venv
  if errorlevel 1 goto nopython
)

"%VENV_PY%" -c "import flask" >nul 2>nul
if errorlevel 1 (
  echo Gerekli paketler kuruluyor, internet baglantisi gerekir...
  "%VENV_PY%" -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 goto fail
)

"%VENV_PY%" yerel_baslat.py %*
if errorlevel 1 goto fail
exit /b 0

:nopython
echo.
echo HATA: Python bulunamadi. Microsoft Store'dan Python 3.12 kurup tekrar deneyin.
pause
exit /b 1

:fail
echo.
echo Durak Ops baslatilamadi. Yukaridaki mesaja bakin.
pause
exit /b 1
