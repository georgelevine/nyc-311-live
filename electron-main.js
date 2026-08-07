const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, shell } = require('electron');

const APP_PORT = 3114;
let mainWindow = null;
let servicesStarted = false;
let liveMonitor = null;

function startServices() {
  if (servicesStarted) return liveMonitor;
  process.env.PORT = String(APP_PORT);
  process.env.HOST = '127.0.0.1';
  process.env.COLLECTOR_SCOPE = process.env.COLLECTOR_SCOPE || 'bid_only';
  // Preserve the existing archive location even though the source repository
  // and package are now named nyc-311-live.
  process.env.DATABASE_PATH = path.join(
    app.getPath('appData'),
    'nyc-bid-311',
    'portal-archive.sqlite'
  );
  process.env.POLL_INTERVAL_SECONDS = process.env.POLL_INTERVAL_SECONDS || '15';
  require('./server');
  liveMonitor = require('./live-311');
  servicesStarted = true;
  return liveMonitor;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The local dashboard service did not start.');
}

async function createWindow() {
  const monitor = startServices();
  mainWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 940,
    minHeight: 620,
    title: 'NYC BID 311 Live',
    backgroundColor: '#f7f9fa',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const [, initialPoll] = await Promise.all([
    waitForServer(),
    Promise.race([
      monitor.firstPoll,
      new Promise(resolve => setTimeout(resolve, 12_000))
    ])
  ]);
  if (initialPoll && initialPoll.fatal) {
    throw new Error(initialPoll.error || 'The BID collector could not start.');
  }
  await mainWindow.loadURL(`http://127.0.0.1:${APP_PORT}/live.html`);
  mainWindow.show();
  if (process.env.SCREENSHOT_PATH) {
    setTimeout(async () => {
      const image = await mainWindow.webContents.capturePage();
      fs.writeFileSync(process.env.SCREENSHOT_PATH, image.toPNG());
      console.log(`Saved app screenshot to ${process.env.SCREENSHOT_PATH}`);
    }, 4000);
  }
  mainWindow.on('closed', () => { mainWindow = null; });
}

function reportStartupError(error) {
  dialog.showErrorBox(
    'NYC BID 311 could not start',
    `${error.message}\n\nThe collector stayed fail-closed; no citywide fallback was used.`
  );
  app.quit();
}

app.whenReady().then(createWindow).catch(reportStartupError);
app.on('activate', () => {
  if (!mainWindow) createWindow().catch(reportStartupError);
});
app.on('before-quit', () => {
  if (liveMonitor && typeof liveMonitor.stop === 'function') {
    liveMonitor.stop('electron-before-quit');
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
