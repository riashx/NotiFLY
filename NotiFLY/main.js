const { app, BrowserWindow, screen, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

let overlayWindow;
let settingsWindow;
let leadMinutes = 5;
const announced = new Set();

const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

function credentialsPath() {
  return path.join(__dirname, "credentials.json");
}

function tokenPath() {
  return path.join(app.getPath("userData"), "token.json");
}

function readToken() {
  try {
    return JSON.parse(fs.readFileSync(tokenPath(), "utf8"));
  } catch {
    return null;
  }
}

function saveToken(token) {
  fs.writeFileSync(tokenPath(), JSON.stringify(token));
}

function createOverlay() {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;

  overlayWindow = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  overlayWindow.loadFile("overlay.html");
  overlayWindow.once("ready-to-show", () => overlayWindow.showInactive());
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
}

function createSettings() {
  settingsWindow = new BrowserWindow({
    width: 420,
    height: 400,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  settingsWindow.loadFile("settings.html");
  settingsWindow.on("closed", () => app.quit());
}

async function getAccessToken() {
  let token = readToken();
  if (!token) return null;

  if (token.expiresAt > Date.now() + 60_000) {
    return token.access_token;
  }

  const { installed } = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: installed.client_id,
      client_secret: installed.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const refreshed = await response.json();

  token = {
    ...token,
    access_token: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };

  saveToken(token);
  return token.access_token;
}

async function connectGoogle() {
  if (!fs.existsSync(credentialsPath())) {
    throw new Error("credentials.json is missing from the NotiFLY folder.");
  }

  const { installed } = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
  const state = crypto.randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      const callbackUrl = new URL(request.url, "http://127.0.0.1");

      if (callbackUrl.searchParams.get("state") !== state) return;

      const code = callbackUrl.searchParams.get("code");

      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<h2>NotiFLY is connected ✈️</h2><p>You can close this tab.</p>");

      server.close();

      try {
        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: installed.client_id,
            client_secret: installed.client_secret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        });

        const token = await tokenResponse.json();

        saveToken({
          ...token,
          expiresAt: Date.now() + token.expires_in * 1000,
        });

        resolve();
      } catch {
        reject(new Error("Google Calendar connection failed."));
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}`;

      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: installed.client_id,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();

      shell.openExternal(url.toString());
    });

    let redirectUri;
  });
}

async function checkCalendar() {
  const accessToken = await getAccessToken();
  if (!accessToken) return;

  const now = new Date();
  const end = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const query = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const data = await response.json();

  for (const event of data.items || []) {
    if (!event.start?.dateTime) continue;

    const minutesAway = (new Date(event.start.dateTime) - Date.now()) / 60_000;
    const eventKey = `${event.id}-${event.start.dateTime}`;

    if (
      minutesAway > 0 &&
      minutesAway <= leadMinutes &&
      !announced.has(eventKey)
    ) {
      announced.add(eventKey);
      overlayWindow.webContents.send(
        "flyby",
        `${event.summary || "Your meeting"} is in ${Math.ceil(minutesAway)} minutes`
      );
    }
  }
}

app.whenReady().then(() => {
  createOverlay();
  createSettings();

  setInterval(() => {
    checkCalendar().catch(() => {});
  }, 30_000);
});

ipcMain.handle("calendar:connect", connectGoogle);

ipcMain.handle("calendar:status", () => Boolean(readToken()));

ipcMain.on("flight:test", () => {
  overlayWindow.webContents.send("flyby", "Your test meeting is in 5 minutes");
});

ipcMain.on("reminder:set", (_event, minutes) => {
  leadMinutes = Number(minutes);
});