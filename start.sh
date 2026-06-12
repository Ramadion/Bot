#!/bin/bash
echo "========================================"
echo " Bot WhatsApp - Inicio rapido"
echo "========================================"
echo ""
if [ ! -d "node_modules" ]; then
    echo "Instalando dependencias..."
    npm install
fi
echo "Iniciando bot..."
echo "Abre http://localhost:3000 en tu navegador"
echo ""
node index.js
