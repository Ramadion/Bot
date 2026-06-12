process.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
process.env.GSETTINGS_BACKEND = 'memory';
process.env.GTK_THEME = 'Adwaita';

const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;
let tray;
let botProcess;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-vulkan');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gtk');

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('Bot WhatsApp');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Abrir', click: () => mainWindow && mainWindow.show() },
    { label: 'Salir', click: () => {
      if (botProcess) botProcess.kill();
      app.isQuitting = true;
      app.quit();
    }},
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => mainWindow && mainWindow.show());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: 'Bot WhatsApp',
    icon: path.join(__dirname, 'public', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL('http://localhost:3000');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', event => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    } else {
      killBotProcess();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function killBotProcess() {
  if (botProcess) {
    botProcess.kill();
    botProcess = null;
  }
  try {
    require('child_process').execSync('fuser -k 3000/tcp 2>/dev/null', { timeout: 2000 });
  } catch {}
}

function startBot() {
  killBotProcess();

  botProcess = fork(path.join(__dirname, 'index.js'), [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  botProcess.stdout.on('data', data => {
    console.log(data.toString());
    if (data.toString().includes('http://localhost:3000') && mainWindow) {
      mainWindow.loadURL('http://localhost:3000');
    }
  });

  botProcess.stderr.on('data', data => {
    console.error(data.toString());
  });

  botProcess.on('exit', code => {
    console.log(`Bot process exited with code ${code}`);
    botProcess = null;
    if (!app.isQuitting) {
      setTimeout(startBot, 3000);
    }
  });
}

app.whenReady().then(() => {
  startBot();
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuitting = true;
  killBotProcess();
});
