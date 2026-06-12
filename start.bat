@echo off
echo ========================================
echo  Bot WhatsApp - Inicio rapido
echo ========================================
echo.
if not exist "node_modules" (
    echo Instalando dependencias...
    call npm install
)
echo Iniciando bot...
echo Abri http://localhost:3000 en tu navegador
echo.
node index.js
pause
