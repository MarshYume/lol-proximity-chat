const { app, BrowserWindow, session } = require('electron');
const https = require('https');
const path = require('path');

let mainWindow;
let pollingInterval;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 320,
    height: 500,
    alwaysOnTop: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Autorise l'accès au microphone sans popup système
  session.defaultSession.setPermissionRequestHandler((_, permission, callback) => {
    callback(permission === 'media');
  });
}

// Lit l'API Live Client de LoL (tourne en local sur le PC du joueur)
function pollLoLAPI() {
  const req = https.request(
    {
      hostname: '127.0.0.1',
      port: 2999,
      path: '/liveclientdata/allgamedata',
      method: 'GET',
      rejectUnauthorized: false, // LoL utilise un certificat auto-signé
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const gameData = JSON.parse(data);
          mainWindow?.webContents.send('lol-data', gameData);
        } catch (_) {}
      });
    }
  );
  req.on('error', () => mainWindow?.webContents.send('lol-offline'));
  req.end();
}

app.whenReady().then(() => {
  createWindow();
  pollingInterval = setInterval(pollLoLAPI, 500);
});

app.on('window-all-closed', () => {
  clearInterval(pollingInterval);
  app.quit();
});
