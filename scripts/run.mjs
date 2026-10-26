import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverScript = join(root, "scripts", "serve.mjs");
const allowedModes = new Set(["local", "lan", "host", "mysql"]);

function usage() {
  console.log(`
Usage: node scripts/run.mjs [local|lan|host|mysql] [--no-browser]

  local  Local PC only; data is stored in this browser (default)
  lan    Accept connections on the local network; data stays browser-local
  host   Store one AES-encrypted dataset on this PC, unlocked by passkey
  mysql  Shared multi-user workspaces in MySQL
`);
}

let mode = "local";
let noBrowser = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--help" || argument === "-h") {
    usage();
    process.exit(0);
  } else if (argument === "--no-browser") {
    noBrowser = true;
  } else if (argument === "--mode") {
    mode = args[index + 1] || "";
    index += 1;
  } else if (allowedModes.has(argument)) {
    mode = argument;
  } else if (["--local", "--lan", "--host", "--mysql"].includes(argument)) {
    mode = argument.slice(2);
  } else {
    console.error(`Unknown argument: ${argument}`);
    usage();
    process.exit(1);
  }
}

if (!allowedModes.has(mode)) {
  console.error(`Unsupported mode: ${mode}`);
  usage();
  process.exit(1);
}

const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be an integer between 1 and 65535.");
  process.exit(1);
}

const bindHost = mode === "lan" ? "0.0.0.0" : "127.0.0.1";
const storage = mode === "host" ? "host" : mode === "mysql" ? "mysql" : "browser";
const dataDirectory = resolve(process.env.BUDGET_CAL_DATA_DIR || join(root, "host-data"));
const url = `http://localhost:${port}`;
const modeLabels = {
  local: "Local PC",
  lan: "Local network",
  host: "Encrypted host storage",
  mysql: "Shared MySQL workspaces",
};

async function serverConfig() {
  try {
    const response = await fetch(`${url}/api/config`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      return null;
    }
    const config = await response.json();
    return config?.app === "Budget Cal" ? config : null;
  } catch {
    return null;
  }
}

function openBrowser() {
  if (noBrowser) {
    return;
  }
  let command;
  let commandArgs;
  if (process.platform === "win32") {
    command = "cmd.exe";
    commandArgs = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    commandArgs = [url];
  } else {
    command = "xdg-open";
    commandArgs = [url];
  }
  const opener = spawn(command, commandArgs, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  opener.on("error", () => {
    console.log(`Open ${url} in your browser.`);
  });
  opener.unref();
}

const existing = await serverConfig();
if (existing) {
  if (existing.storage !== storage) {
    console.error(
      `Port ${port} is already running Budget Cal in ${existing.storage} storage mode.`,
    );
    console.error("Stop it or choose another PORT before starting a different mode.");
    process.exit(1);
  }
  console.log(`\nBudget Cal is already running in ${modeLabels[mode]} mode.`);
  console.log(url);
  openBrowser();
  process.exit(0);
}

console.log(`\nStarting Budget Cal in ${modeLabels[mode]} mode...`);
console.log(`App URL: ${url}`);
if (mode === "host") {
  console.log(`Encrypted data directory: ${dataDirectory}`);
  console.log("Use your platform passkey in the browser to create or unlock the data.");
  console.log("Host mode is available only on this PC.");
} else if (mode === "mysql") {
  console.log("MySQL mode requires BUDGET_CAL_DATABASE_URL and the shared server configuration.");
} else if (mode === "lan") {
  console.log("Other devices on this network can use the Network access URL shown below.");
  console.log("Browser-local data remains separate on each device.");
}
console.log("Press Ctrl+C to stop.\n");

const childEnvironment = {
  ...process.env,
  HOST: bindHost,
  PORT: String(port),
  STORAGE_MODE: storage,
};

const server = spawn(process.execPath, [serverScript], {
  cwd: root,
  env: childEnvironment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (server.exitCode === null) {
      server.kill(signal);
    }
  });
}

let browserOpened = false;
const browserTimer = setInterval(async () => {
  if (browserOpened || server.exitCode !== null) {
    return;
  }
  if (await serverConfig()) {
    browserOpened = true;
    clearInterval(browserTimer);
    openBrowser();
  }
}, 250);

const exitCode = await new Promise((resolvePromise) => {
  server.on("exit", (code) => resolvePromise(code ?? 1));
  server.on("error", (error) => {
    console.error(error.message);
    resolvePromise(1);
  });
});
clearInterval(browserTimer);
process.exitCode = exitCode;
