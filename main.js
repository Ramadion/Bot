process.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
process.env.GSETTINGS_BACKEND = 'memory';
process.env.GTK_THEME = 'Adwaita';

const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { createBot } = require('./bot');

let mainWindow;
let tray;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-gtk');

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Bot WhatsApp');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir Web', click: () => {
      const { shell } = require('electron');
      shell.openExternal('http://localhost:3000');
    }},
    { label: 'Salir', click: () => {
      app.isQuitting = true;
      app.quit();
    }},
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    const { shell } = require('electron');
    shell.openExternal('http://localhost:3000');
  });
}

app.whenReady().then(async () => {
  createTray();

  try {
    await createBot(3000);
    console.log(`🌐 Abrí http://localhost:3000 en tu navegador`);
    const { shell } = require('electron');
    shell.openExternal('http://localhost:3000');
  } catch (err) {
    console.error('❌ Error al iniciar:', err.message);
  }
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuitting = true;
});
