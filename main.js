process.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
process.env.GSETTINGS_BACKEND = 'memory';
process.env.GTK_THEME = 'Adwaita';

const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');

let mainWindow;
let tray;
let botProcess;
let restartAttempts = 0;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
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
      app.isQuitting = true;
      killBotProcess();
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

  mainWindow.loadFile(path.join(__dirname, 'public', 'loading.html'));
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

function isOnLoadingPage() {
  if (!mainWindow) return false;
  try {
    const url = mainWindow.webContents.getURL();
    return !url || url.includes('loading.html') || url.startsWith('chrome-error://') || url.startsWith('about:');
  } catch { return true; }
}

function pollServer() {
  const poll = () => {
    setTimeout(poll, 1500);
    if (!mainWindow) return;
    const req = http.get('http://localhost:3000/api/status', res => {
      res.resume();
      if (res.statusCode === 200 && isOnLoadingPage()) {
        console.log('🌐 Servidor listo, cargando dashboard...');
        mainWindow.loadURL('http://localhost:3000');
      }
    });
    req.on('error', () => {});
    req.setTimeout(5000, () => req.destroy());
    req.end();
  };
  poll();
}

function startBot() {
  killBotProcess();

  botProcess = fork(path.join(__dirname, 'index.js'), [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  botProcess.stdout.on('data', data => {
    console.log(data.toString());
  });

  botProcess.stderr.on('data', data => {
    console.error(data.toString());
  });

  botProcess.on('exit', code => {
    console.log(`Bot process exited with code ${code}`);
    botProcess = null;
    if (!app.isQuitting && restartAttempts < 3) {
      restartAttempts++;
      if (mainWindow && !isOnLoadingPage()) {
        mainWindow.loadFile(path.join(__dirname, 'public', 'loading.html'));
      }
      setTimeout(startBot, 3000);
    } else if (!app.isQuitting) {
      console.error('❌ Demasiados reinicios. Deteniendo.');
    }
  });
}

app.whenReady().then(() => {
  startBot();
  pollServer();
  createTray();
  createWindow();
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  app.isQuitting = true;
  killBotProcess();
});
