// Invoice Assistant desktop app (Electron). It starts the same local server as `npm run app` inside the app,
// on a free port on 127.0.0.1, and shows it in its own window. Same agent, tools and safety rules.
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
app.setName("Invoice Assistant");
app.setAppUserModelId("com.aiautomation0420.invoiceassistant"); // own taskbar icon on Windows

if (!app.requestSingleInstanceLock()) app.quit(); // a second double-click focuses the open window

// The installed app refuses debugging switches, so nobody can attach to it and drive it from outside.
// (The Node ones are also switched off at build time with Electron fuses, see "electronFuses" in package.json.)
if (app.isPackaged && ["remote-debugging-port", "remote-debugging-pipe", "remote-allow-origins", "inspect", "inspect-brk"].some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1);
}

// Settings: while developing, the project's .env. Installed, a settings file in the user's app-data folder
// (never inside the installer, so no keys are ever packaged).
const dataDir = app.getPath("userData");
const envFile = app.isPackaged ? join(dataDir, ".env") : join(ROOT, ".env");
if (app.isPackaged) {
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(envFile)) copyFileSync(join(ROOT, ".env.example"), envFile);
  process.env.INVOICE_ASSISTANT_DATA = dataDir; // logs/ and reports/ go here (the install folder is read-only)
}
if (existsSync(envFile)) process.loadEnvFile(envFile);

let win;

async function start() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Invoice Assistant: set up",
      message: "Add your Supabase settings to get started",
      detail: `Open the settings file, fill in SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (the same values as the dashboard), save it, then start Invoice Assistant again.\n\nSettings file:\n${envFile}`,
      buttons: ["Open settings file", "Quit"],
      defaultId: 0,
    });
    if (response === 0) await shell.openPath(envFile);
    return app.quit();
  }

  // Load after the settings, so the data layer and providers read them. Node 24 runs the .ts files directly.
  const [{ createApp }, { supabaseData }, { MODEL, createProvider }] = await Promise.all([
    import("../src/server.ts"),
    import("../src/data.ts"),
    import("../src/providers/index.ts"),
  ]);
  const keyFile = join(ROOT, "samples", "planted-differences.json");
  const statementMonth = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, "utf8")).month : undefined;

  let server;
  try {
    server = createApp({ data: supabaseData(), makeProvider: createProvider, info: { provider: "", model: MODEL, statementMonth } });
  } catch (err) {
    dialog.showErrorBox("Invoice Assistant", `${err instanceof Error ? err.message : err}\n\nSettings file: ${envFile}`);
    return app.quit();
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); // a free port, this computer only
  const url = `http://localhost:${server.address().port}`;
  app.on("will-quit", () => server.close());

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    title: "Invoice Assistant",
    icon: join(ROOT, "desktop", "icon.png"),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#fafafa",
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());

  // Stay on the app: other links open in the normal browser; nothing can navigate this window away.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target) && !target.startsWith(url)) shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) event.preventDefault();
  });
  await win.loadURL(url);
}

Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        { label: "Open settings file", click: () => shell.openPath(envFile) },
        { label: "Open reports folder", click: () => { const dir = join(process.env.INVOICE_ASSISTANT_DATA || ROOT, "reports"); mkdirSync(dir, { recursive: true }); shell.openPath(dir); } },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
  ]),
);

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on("window-all-closed", () => app.quit());
app.whenReady().then(start).catch((err) => {
  dialog.showErrorBox("Invoice Assistant", String(err?.stack ?? err));
  app.quit();
});
