@echo off
chcp 65001 >nul
setlocal
title SafeSchool AI - La chan So Hoc duong

cd /d "%~dp0"

echo ============================================================
echo   SafeSchool AI - La chan So Hoc duong
echo   Team Victer - DNT - Nguyen Tien Duc
echo   THPT Ton Duc Thang, xa Ta Lai, Thanh pho Dong Nai
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [LOI] Khong tim thay Node.js tren may nay.
    echo Vui long cai dat Node.js phien ban ^>= 22.0.0 tai: https://nodejs.org/
    goto :fail
)

for /f "tokens=*" %%V in ('node -v') do set "NODE_VER=%%V"
echo [OK] Da phat hien Node.js %NODE_VER%

if not exist "node_modules\" (
    echo.
    echo [1/3] Dang cai dat thu vien Node.js ^(lan dau khoi chay^)...
    call npm install
    if errorlevel 1 (
        echo [LOI] Cai dat thu vien that bai. Vui long kiem tra ket noi mang hoac npm.
        goto :fail
    )
)

if not exist ".env" (
    if exist ".env.example" (
        echo [2/3] Chua co file .env - dang tao tu .env.example...
        copy /y ".env.example" ".env" >nul
    )
)

set "APP_PORT=%PORT%"
if "%APP_PORT%"=="" (
    if exist ".env" (
        for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
            if /i "%%~A"=="PORT" if not "%%~B"=="" set "APP_PORT=%%~B"
        )
    )
)
if "%APP_PORT%"=="" set "APP_PORT=3000"
for /f "tokens=* delims= " %%P in ("%APP_PORT%") do set "APP_PORT=%%P"

set "APP_URL=http://localhost:%APP_PORT%"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '%APP_URL%/api/health' -UseBasicParsing -TimeoutSec 1; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
    echo.
    echo [THONG BAO] SafeSchool AI da dang chay tai %APP_URL%
    if /i not "%~1"=="--no-browser" (
        echo Dang mo trinh duyet...
        start "" "%APP_URL%"
    )
    timeout /t 3 /nobreak >nul
    exit /b 0
)

echo.
echo [3/3] Dang khoi dong may chu SafeSchool AI tai %APP_URL% ...
if /i not "%~1"=="--no-browser" (
    echo Trinh duyet se tu dong mo khi may chu san sang.
    start "" /b powershell -NoProfile -WindowStyle Hidden -Command "$u='%APP_URL%'; for($i=0; $i -lt 40; $i++) { try { $r=Invoke-WebRequest -Uri ($u + '/api/health') -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){ Start-Process $u; exit 0 } } catch {} Start-Sleep -Milliseconds 500 }"
)
echo Nhan Ctrl + C tai cua so nay de dung ung dung.
echo.

node server.js
if errorlevel 1 (
    echo.
    echo [LOI] May chu dung dot ngot ^(ma loi: %errorlevel%^).
    goto :fail
)

exit /b 0

:fail
echo.
pause
exit /b 1
