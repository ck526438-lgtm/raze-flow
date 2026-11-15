'use strict';
// Application de bureau RAZE Flow : démarre le serveur en interne et l'affiche dans une fenêtre.
const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const SMOKE = process.env.RAZE_SMOKE === '1'; // test automatique : démarre, vérifie, quitte
const PREFERRED_PORT = Number(process.env.PORT || 5678);
const ICON = path.join(__dirname, 'tray.png');

let win = null;
let tray = null;
let server = null;
let baseUrl = '';
let quitting = false;
let warnedBackground = false;

// Les données vivent dans le dossier utilisateur (jamais dans le dossier d'installation)
process.env.RAZE_DATA_DIR = SMOKE
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'raze-smoke-'))
  : process.env.RAZE_DATA_DIR || path.join(app.getPath('userData'), 'data');

async function startServer() {
  const { start } = require('../src/server');
  const host = process.env.HOST || '127.0.0.1';
  try {
    return await start({ port: SMOKE ? 0 : PREFERRED_PORT, host, quiet: true });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    return start({ port: 0, host, quiet: true }); // port occupé : on en prend un libre
  }
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 840, minWidth: 380, minHeight: 520,
    backgroundColor: '#12040c', title: 'RAZE Flow', icon: ICON,
    autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden') && !SMOKE) win.show(); });
  win.loadURL(baseUrl);

  // Les liens externes s'ouvrent dans le navigateur par défaut
  const external = (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(baseUrl)) { e.preventDefault(); external(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F5') win.webContents.reload();
  });

  // Fermer la fenêtre ne quitte pas : les webhooks et planifications continuent
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!warnedBackground && tray && process.platform === 'win32') {
      warnedBackground = true;
      tray.displayBalloon({ title: 'RAZE Flow reste actif', content: 'Vos workflows continuent en arrière-plan. Clic droit sur l’icône pour quitter.' });
    }
  });
  win.on('closed', () => { win = null; });
}

async function quit() {
  if (win && !win.isDestroyed()) {
    const dirty = await win.webContents.executeJavaScript('typeof state !== "undefined" && state.dirty').catch(() => false);
    if (dirty) {
      showWindow();
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning', buttons: ['Annuler', 'Quitter sans enregistrer'], defaultId: 0, cancelId: 0,
        title: 'RAZE Flow', message: 'Des modifications ne sont pas enregistrées.',
      });
      if (choice === 0) return;
    }
  }
  quitting = true;
  try { require('../src/server').scheduler.stop(); } catch { /* déjà arrêté */ }
  if (win && !win.isDestroyed()) win.destroy();
  if (server) server.close();
  app.quit();
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip('RAZE Flow');
  const login = app.getLoginItemSettings({ args: ['--hidden'] });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir RAZE Flow', click: showWindow },
    { label: 'Ouvrir dans le navigateur', click: () => shell.openExternal(baseUrl) },
    { label: 'Ouvrir le dossier des données', click: () => shell.openPath(process.env.RAZE_DATA_DIR) },
    { type: 'separator' },
    {
      label: 'Lancer au démarrage de Windows', type: 'checkbox', checked: login.openAtLogin, visible: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: 'Quitter', click: quit },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

async function smokeTest() {
  const fail = (msg) => { console.error(`SMOKE KO : ${msg}`); app.exit(1); };
  setTimeout(() => fail('délai dépassé'), 45000);
  try {
    await new Promise((resolve, reject) => {
      win.webContents.once('did-finish-load', resolve);
      win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(desc)));
    });
    // L'interface doit créer le workflow de démo puis l'exécuter avec succès
    const status = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function wait() {
        if (document.querySelectorAll('.node').length >= 7) return run().then(() => resolve(state.exec && state.exec.status), reject);
        if (Date.now() - t0 > 20000) return reject(new Error('interface non chargée'));
        setTimeout(wait, 200);
      })();
    })`);
    if (status !== 'success') return fail(`exécution = ${status}`);
    const health = await (await fetch(`${baseUrl}/api/health`)).json();
    console.log(`SMOKE OK : ${health.name} ${health.version}, démo exécutée`);
    app.exit(0);
  } catch (err) { fail(err.message); }
}

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => { /* on reste dans la zone de notification */ });
  app.on('before-quit', () => { quitting = true; });
  app.setAppUserModelId('ci.razeflow.app');
  Menu.setApplicationMenu(null);

  app.whenReady().then(async () => {
    try {
      server = await startServer();
      baseUrl = `http://127.0.0.1:${server.address().port}`;
    } catch (err) {
      if (SMOKE) { console.error(err); return app.exit(1); }
      dialog.showErrorBox('RAZE Flow', `Impossible de démarrer : ${err.message}`);
      return app.exit(1);
    }
    createWindow();
    if (SMOKE) return smokeTest();
    createTray();
  });
}
