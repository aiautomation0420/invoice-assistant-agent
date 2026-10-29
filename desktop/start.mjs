// npm run desktop: starts the desktop app from the project folder.
// VS Code (and tools inside it) set ELECTRON_RUN_AS_NODE=1, which makes Electron act like plain Node; clear it.
import { spawn } from "node:child_process";
import electron from "electron"; // the electron package's default export is the path to electron.exe

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, ["."], { stdio: "inherit", env, cwd: new URL("..", import.meta.url) }).on("exit", (code) => process.exit(code ?? 0));
