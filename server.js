'use strict';
// PCRemote host: streams this PC's screen to a browser on the LAN and injects the
// browser's mouse/keyboard input. One controller at a time, unattended access.

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');

const win = require('./lib/win');
const { Encoder, QUALITY_CQ } = require('./lib/encoder');
const { InputController } = require('./lib/input');
const { AudioCapture } = require('./lib/audio');
const { GamepadBridge } = require('./lib/gamepad');
const { ensureCertificates, buildLaptopBundle } = require('./lib/certs');

win.makeDpiAware();

const ROOT = __dirname;
const DATA = process.env.PCREMOTE_DATA || path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const FFMPEG = path.join(ROOT, 'bin', 'ffmpeg.exe');
const CONFIG_FILE = path.join(DATA, 'config.json');
const LOG_FILE = path.join(DATA, 'pcremote.log');
// start-hidden.vbs restarts the host after a crash, but not after this code
// (setup problems that a restart can't fix).
const EXIT_SETUP = 3;

fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- logging

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2e6) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging must never take the server down */ }
}

// ---------------------------------------------------------------- config & auth

const DEFAULT_CONFIG = {
  port: 9443,
  password: null, // { salt, hash } (scrypt)
  devices: [], // remembered laptops: { id, name, hash, created, lastUsed }
  uploadDir: path.join(os.homedir(), 'Downloads', 'PCRemote'),
  // Which interfaces to listen on: 'tailscale' (only the Tailscale IP — the port
  // is then invisible on the LAN and the internet), 'lan', or 'all'. install.bat
  // switches this to 'tailscale'; the default stays 'lan' so an un-set-up host is
  // never left unreachable.
  bind: 'lan',
  allowLan: false, // with bind:'tailscale', also listen on the home LAN addresses
  enrolledClients: [], // sha256 fingerprints of client certs allowed to connect
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
  const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''); // Notepad may add a BOM
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    // Never fall back to defaults here: the next save would wipe the password and devices.
    log(`${CONFIG_FILE} is not valid JSON (${e.message}). Fix it or delete it to start over.`);
    process.exit(EXIT_SETUP);
  }
}
let configText = '';
function saveConfig() {
  configText = JSON.stringify(config, null, 2);
  fs.writeFileSync(CONFIG_FILE, configText);
}
let config = loadConfig();

// set-password.bat edits the file while the host runs: pick that up, or our next
// save would write the old password back.
function watchConfig() {
  fs.watchFile(CONFIG_FILE, { interval: 1000 }, () => {
    let text;
    try { text = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, ''); } catch { return; }
    if (text === configText) return;
    try { config = { ...DEFAULT_CONFIG, ...JSON.parse(text) }; } catch { return; }
    configText = text;
    log('config.json changed, reloaded');
    // Drop the live session if its laptop was signed out (password changed) or its
    // certificate was revoked (a new laptop was enrolled).
    const revoked = active && ((active.deviceId && !config.devices.some((d) => d.id === active.deviceId))
      || (active.clientFp && !config.enrolledClients.includes(active.clientFp)));
    if (revoked) {
      active.send({ t: 'kicked' });
      active.ws.close(4005, 'access revoked');
      active.close('access revoked');
    }
  });
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function checkPassword(pw) {
  if (!config.password || typeof pw !== 'string') return false;
  const a = crypto.scryptSync(pw, config.password.salt, 32);
  return crypto.timingSafeEqual(a, Buffer.from(config.password.hash, 'hex'));
}
function findDevice(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const h = Buffer.from(sha256(token), 'hex');
  return config.devices.find((d) => crypto.timingSafeEqual(h, Buffer.from(d.hash, 'hex'))) || null;
}

// Per-IP lockout after repeated failures, plus a cap across all addresses so
// hopping between IPs doesn't buy extra guesses.
const failures = new Map();
const recentFailures = []; // timestamps of failed logins from any address
const GLOBAL_WINDOW = 15 * 60e3, GLOBAL_MAX = 20;
function lockedOut(ip) {
  const f = failures.get(ip);
  if (f && f.until > Date.now()) return true;
  while (recentFailures.length && recentFailures[0] < Date.now() - GLOBAL_WINDOW) recentFailures.shift();
  return recentFailures.length >= GLOBAL_MAX;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (f.count - 5));
  failures.set(ip, f);
  recentFailures.push(Date.now());
}

const MIN_PASSWORD = 8;

async function promptPassword(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  rl._writeToOutput = (s) => rl.output.write(muted ? (s.includes('\n') ? '\n' : '*') : s);
  const ask = (q) => new Promise((resolve) => { muted = false; rl.question(q, (a) => resolve(a)); muted = true; });
  try {
    for (;;) {
      const a = await ask(question);
      if (a.length < MIN_PASSWORD) { console.log(`\n  Password must be at least ${MIN_PASSWORD} characters.`); continue; }
      const b = await ask('Repeat password: ');
      if (a === b) return a;
      console.log('\n  Passwords did not match, try again.');
    }
  } finally { rl.close(); }
}

async function setPassword(pw) {
  config.password = hashPassword(pw);
  config.devices = []; // a new password signs out every remembered laptop
  saveConfig();
}

// ---------------------------------------------------------------- tailscale & client auth

const TAILSCALE_PATHS = [
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
];
// Looked up on demand, not at load: Tailscale can be installed after the server started.
let tailscaleExe = null;
const findTailscaleExe = () => tailscaleExe || (tailscaleExe = TAILSCALE_PATHS.find((p) => fs.existsSync(p)) || null);

// Best-effort: the Tailscale IPv4 (100.x) and MagicDNS name for this PC, or null.
// Cached so it never runs on the hot path (cert refresh, bind retries) more than
// once a minute — the sync call must not stall an active video session.
let tsCache = { at: 0, value: null };
function detectTailscale(maxAgeMs = 60e3) {
  if (Date.now() - tsCache.at < maxAgeMs) return tsCache.value;
  const exe = findTailscaleExe();
  let value = null;
  if (exe) {
    try {
      const status = JSON.parse(execFileSync(exe, ['status', '--json'], { timeout: 2500 }));
      if (status.Self && status.BackendState === 'Running') {
        const ip = (status.Self.TailscaleIPs || []).find((a) => /^100\./.test(a));
        if (ip) value = { ip, name: (status.Self.DNSName || '').replace(/\.$/, '').toLowerCase() || null };
      }
    } catch { /* Tailscale not running */ }
  }
  tsCache = { at: Date.now(), value };
  return value;
}

// The one check that gates every connection: a valid client certificate from our
// device CA whose fingerprint we enrolled. No certificate, wrong CA, or an
// un-enrolled certificate all fail here, before any password is even considered.
function clientFingerprint(socket) {
  if (!socket || !socket.authorized) return null;
  const cert = socket.getPeerCertificate ? socket.getPeerCertificate() : null;
  if (!cert || !cert.fingerprint256) return null;
  return cert.fingerprint256.replace(/:/g, '').toLowerCase();
}
function isAuthorizedClient(socket) {
  const fp = clientFingerprint(socket);
  return !!fp && config.enrolledClients.includes(fp);
}
// The certificate lock engages only once a laptop has been enrolled (install.bat).
// Before that, access is password-only, so upgrading the code can never lock the
// current laptop out before its certificate is installed.
const certRequired = () => config.enrolledClients.length > 0;
const clientAllowed = (socket) => !certRequired() || isAuthorizedClient(socket);

// ---------------------------------------------------------------- settings

const FPS_CHOICES = [30, 60, 90, 120, 144];
const MAX_CLIP = 2e6; // characters of clipboard text synced either way

function sanitizeSettings(s, outputs) {
  s = s || {};
  const primary = outputs.find((o) => o.primary) || outputs[0];
  const monitor = outputs.some((o) => o.index === s.monitor) ? s.monitor : (primary ? primary.index : 0);
  return {
    monitor,
    fps: FPS_CHOICES.includes(s.fps) ? s.fps : 60,
    quality: s.quality in QUALITY_CQ ? s.quality : 'high',
    maxBitrate: Math.max(5, Math.min(150, Math.round(Number(s.maxBitrate) || 40))),
    drawMouse: s.drawMouse !== false,
  };
}

// ---------------------------------------------------------------- session

const now = () => performance.timeOrigin + performance.now();
let active = null;

class Session {
  constructor(ws, ip, device, deviceId, clientFp, settings) {
    this.ws = ws;
    this.ip = ip;
    this.device = device;
    this.deviceId = deviceId;
    this.clientFp = clientFp; // the laptop's certificate fingerprint, for live revocation
    this.closed = false;
    this.token = crypto.randomBytes(24).toString('base64url'); // authorizes uploads for this session
    this.outputs = win.listOutputs();
    this.settings = sanitizeSettings(settings, this.outputs);
    this.input = new InputController();
    this.encoder = new Encoder(FFMPEG);
    this.gen = 0;
    this.waitKey = true;
    this.congested = false;
    this.drainTimer = null;
    this.bitrate = this.settings.maxBitrate; // lowered automatically when the link can't keep up
    this.paused = false;
    this.restartTimer = null;
    this.failures = 0;
    this.lastFrameAt = 0;
    this.startedAt = 0;
    this.lastSeen = now(); // any client message; the client pings every second

    this.encoder.on('config', (c) => {
      this.gen = (this.gen + 1) & 0xffff;
      this.waitKey = true;
      const out = this.currentOutput();
      this.send({ t: 'video', gen: this.gen, codec: c.codec, description: c.description.toString('base64'), width: out.width, height: out.height });
    });
    this.encoder.on('frame', (f) => this.onFrame(f));
    this.encoder.on('exit', ({ code, stderr }) => {
      if (this.closed || this.paused) return;
      this.failures++;
      log(`encoder exited (code ${code})`, stderr.split('\n').slice(-3).join(' | '));
      this.send({ t: 'status', state: 'nocapture', detail: stderr.split('\n').pop() || '' });
      this.scheduleRestart(Math.min(3000, 250 * this.failures));
    });

    // Liveness is handled by the WebSocket heartbeat; this only restarts stuck capture.
    // ddagrab duplicates frames, so silence means capture is stuck (e.g. a desktop switch).
    this.watchdog = setInterval(() => {
      if (this.paused || this.congested || !this.encoder.proc) return;
      if (now() - Math.max(this.lastFrameAt, this.startedAt) > 4000) {
        log('no frames for 4s, restarting capture');
        this.startVideo();
      }
    }, 1000);

    this.clipSeq = win.clipboardSequence();
    this.clipTimer = setInterval(() => this.pollClipboard(), 300);
    win.keepAwake(true);
    this.startVideo();

    // Audio: dropped (never queued) when the link is behind, so it can't add delay.
    this.audio = new AudioCapture();
    this.audio.on('data', (pcm) => {
      if (this.closed || this.ws.readyState !== 1 || this.ws.bufferedAmount > 64 * 1024) return;
      const msg = Buffer.allocUnsafe(2 + pcm.length);
      msg[0] = 2;
      msg[1] = 0;
      pcm.copy(msg, 2);
      this.ws.send(msg, { binary: true });
    });
    this.audio.start();

    this.gamepad = new GamepadBridge();
    this.gamepad.on('rumble', (slot, large, small) => this.send({ t: 'rumble', slot, large, small }));
    this.gamepad.on('nodriver', () => { log('gamepad: controller support is not set up (run install.bat and enable it)'); this.send({ t: 'status', state: 'nogamepad' }); });
  }

  currentOutput() {
    return this.outputs.find((o) => o.index === this.settings.monitor) || this.outputs[0] || { index: 0, left: 0, top: 0, width: 1920, height: 1080 };
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  startVideo() {
    clearTimeout(this.restartTimer);
    clearTimeout(this.drainTimer);
    this.restartTimer = this.drainTimer = null;
    if (this.closed || this.paused) return;
    this.refreshOutputs();
    this.waitKey = true;
    this.congested = false;
    this.startedAt = now();
    this.encoder.start({ outputIndex: this.settings.monitor, fps: this.settings.fps, maxBitrate: this.bitrate, quality: this.settings.quality, drawMouse: this.settings.drawMouse });
  }

  // Monitors can be plugged/unplugged mid-session; keep the capture index and mouse mapping in step.
  refreshOutputs() {
    const outs = win.listOutputs();
    if (outs.length && JSON.stringify(outs) !== JSON.stringify(this.outputs)) {
      this.outputs = outs;
      this.settings = sanitizeSettings(this.settings, outs);
      this.send({ t: 'settings', settings: this.settings, monitors: outs });
    }
    this.input.setRect(this.currentOutput());
  }

  scheduleRestart(ms) {
    if (this.restartTimer || this.closed) return;
    this.restartTimer = setTimeout(() => { this.restartTimer = null; this.startVideo(); }, ms);
  }

  onFrame(f) {
    this.lastFrameAt = now();
    if (this.failures && this.lastFrameAt - this.startedAt > 5000) this.failures = 0;
    if (this.waitKey) {
      if (!f.key) return;
      this.waitKey = false;
      this.send({ t: 'status', state: 'streaming' });
    }
    if (this.congested) return;
    // ~100ms of video queued in user space means the link can't keep up: stop
    // feeding it, let it drain, then resume at a lower bitrate with a fresh keyframe.
    const highWater = Math.max(384 * 1024, this.bitrate * 1e6 / 8 / 10);
    if (this.ws.bufferedAmount > highWater) {
      this.congested = true;
      this.encoder.stop();
      this.bitrate = Math.max(5, Math.round(this.bitrate * 0.7));
      log(`network congested, lowering bitrate cap to ${this.bitrate} Mbps`);
      this.send({ t: 'status', state: 'congested', bitrate: this.bitrate });
      const drain = () => {
        if (this.closed) return;
        if (this.ws.bufferedAmount < 32 * 1024) this.startVideo();
        else this.drainTimer = setTimeout(drain, 15);
      };
      drain();
      return;
    }
    const msg = Buffer.allocUnsafe(12 + f.data.length);
    msg[0] = 1;
    msg[1] = f.key ? 1 : 0;
    msg.writeUInt16LE(this.gen, 2);
    msg.writeDoubleLE(this.lastFrameAt, 4);
    f.data.copy(msg, 12);
    this.ws.send(msg, { binary: true });
  }

  pollClipboard() {
    const seq = win.clipboardSequence();
    if (seq === this.clipSeq) return;
    const text = win.readClipboardText();
    if (text === undefined) return; // another app has the clipboard open; try next tick
    this.clipSeq = seq;
    if (text && text.length <= MAX_CLIP) this.send({ t: 'clip', text });
  }

  writeClipboard(text, attempt = 0) {
    if (this.closed) return;
    if (win.writeClipboardText(text)) this.clipSeq = win.clipboardSequence();
    else if (attempt < 5) setTimeout(() => this.writeClipboard(text, attempt + 1), 100);
  }

  onControl(m) {
    switch (m.t) {
      case 'ping':
        this.send({ t: 'pong', c: m.c, s: now() });
        break;
      case 'settings': {
        this.outputs = win.listOutputs();
        this.settings = sanitizeSettings({ ...this.settings, ...m.settings }, this.outputs);
        this.bitrate = this.settings.maxBitrate;
        this.input.releaseAll();
        this.send({ t: 'settings', settings: this.settings, monitors: this.outputs });
        this.startVideo();
        break;
      }
      case 'keyframe':
        if (now() - this.startedAt > 500) this.startVideo();
        break;
      case 'pause':
        this.paused = true;
        this.input.releaseAll();
        this.encoder.stop();
        break;
      case 'resume':
        if (this.paused) { this.paused = false; this.startVideo(); }
        break;
      case 'audio':
        if (m.on) this.audio.start(); else this.audio.stop();
        break;
      case 'clip':
        if (typeof m.text === 'string' && m.text.length <= MAX_CLIP) this.writeClipboard(m.text);
        break;
      case 'forget':
        if (this.deviceId) {
          config.devices = config.devices.filter((d) => d.id !== this.deviceId);
          saveConfig();
          log(`device forgotten: ${this.device}`);
        }
        break;
    }
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    clearInterval(this.clipTimer);
    clearTimeout(this.restartTimer);
    this.encoder.stop();
    this.audio.stop();
    this.gamepad.stop();
    this.input.releaseAll();
    win.keepAwake(false);
    if (active === this) active = null;
    log(`session ended (${reason}) for ${this.device} @ ${this.ip}`);
  }
}

// ---------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon',
};
const SECURITY_HEADERS = {
  // Only takes effect once the laptop trusts our CA; from then on the browser
  // refuses an impostor certificate outright instead of offering "Continue".
  'Strict-Transport-Security': 'max-age=15552000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss:; style-src 'self' 'unsafe-inline'",
};

function safeUploadName(name) {
  const base = path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 180);
  return base || 'file';
}

function handleUpload(req, res) {
  const s = active;
  const token = req.headers['x-session'];
  if (!clientAllowed(req.socket) || !s || typeof token !== 'string' || token.length !== s.token.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(s.token))) {
    res.writeHead(401).end();
    req.resume();
    return;
  }
  let name;
  try { name = safeUploadName(decodeURIComponent(req.headers['x-filename'] || '')); } catch { name = 'file'; }
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  let target = path.join(config.uploadDir, name);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(config.uploadDir, `${stem} (${i})${ext}`);
  const out = fs.createWriteStream(target, { flags: 'wx' });
  req.pipe(out);
  out.on('finish', () => {
    log(`received file ${target}`);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, path: target }));
  });
  const fail = (e) => { out.destroy(); fs.rm(target, { force: true }, () => {}); if (!res.headersSent) res.writeHead(500).end(String(e && e.message)); };
  out.on('error', fail);
  req.on('aborted', fail);
}

function createHttpHandler() {
  return (req, res) => {
    const url = new URL(req.url, 'https://x');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    if (req.method === 'POST' && url.pathname === '/upload') return handleUpload(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();

    // Once a laptop is enrolled, any other device (no or wrong certificate) gets this
    // one self-contained page for every path, and nothing else.
    if (!clientAllowed(req.socket)) {
      res.writeHead(403, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(PUBLIC, 'unauthorized.html')));
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  };
}

// ---------------------------------------------------------------- websocket

function attachWebSocket(server) {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 16 * 1024 * 1024, // room for MAX_CLIP characters even after UTF-8 and JSON escaping
    perMessageDeflate: false,
    verifyClient: ({ origin, req }) => {
      // Once a laptop is enrolled, only its certificate gets this far.
      if (!clientAllowed(req.socket)) return false;
      // And only our own page may open the socket, so another website in the
      // laptop's browser can't drive it (cross-site WebSocket hijacking).
      try { return new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase(); } catch { return false; }
    },
  });

  wss.on('connection', (ws, req) => {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    ws._socket.setNoDelay(true);
    let session = null;
    const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), 10000);

    // Liveness at the protocol level: the browser answers these pings from its own
    // network thread, so a busy page (heavy decoding) still proves it is alive and
    // we never tear the session down by mistake.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; if (session) session.lastSeen = now(); });

    ws.on('message', (data, isBinary) => {
      if (session) {
        session.lastSeen = now();
        if (isBinary) { if (data[0] === 7 || data[0] === 8) session.gamepad.handle(data); else session.input.handle(data); }
        else { try { session.onControl(JSON.parse(data)); } catch (e) { log('bad control message', String(e)); } }
        return;
      }
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data); } catch { return ws.close(4002, 'bad hello'); }
      if (m.t !== 'auth') return;
      clearTimeout(authTimer);

      let device = findDevice(m.deviceToken);
      let newToken = null;
      if (!device) {
        // Lockouts gate password guesses only; a remembered laptop always gets in.
        if (lockedOut(ip)) {
          ws.send(JSON.stringify({ t: 'auth', ok: false, error: 'locked' }));
          return ws.close(4003, 'locked');
        }
        if (!checkPassword(m.password)) {
          recordFailure(ip);
          log(`failed login from ${ip}`);
          ws.send(JSON.stringify({ t: 'auth', ok: false, error: m.password ? 'password' : 'token' }));
          return ws.close(4003, 'denied');
        }
        if (m.remember) {
          newToken = crypto.randomBytes(32).toString('base64url');
          device = { id: crypto.randomUUID(), name: String(m.deviceName || 'device').slice(0, 80), hash: sha256(newToken), created: Date.now(), lastUsed: 0 };
          config.devices.push(device);
        }
      }
      failures.delete(ip);
      if (device) { device.lastUsed = Date.now(); saveConfig(); }

      if (active) {
        active.send({ t: 'kicked' });
        active.ws.close(4004, 'replaced');
        active.close('replaced by a new connection');
      }
      const label = device ? device.name : String(m.deviceName || 'device').slice(0, 80);
      session = new Session(ws, ip, label, device ? device.id : null, clientFingerprint(req.socket), m.settings);
      active = session;
      log(`session started for ${label} @ ${ip}`, session.settings);
      ws.send(JSON.stringify({ t: 'auth', ok: true, deviceToken: newToken, session: session.token, host: os.hostname(), monitors: session.outputs, settings: session.settings }));
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (session) session.close('disconnected');
    });
    ws.on('error', () => {});
  });

  // Ping every 3s; drop a client that misses two in a row (~6-9s of real silence,
  // e.g. the laptop slept or Wi-Fi dropped) so held keys/buttons get released.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* socket already going away */ }
    }
  }, 3000);
  wss.on('close', () => clearInterval(beat));
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const setPw = args.find((a) => a.startsWith('--set-password'));
  if (setPw) {
    const inline = setPw.includes('=') ? setPw.slice(setPw.indexOf('=') + 1) : null;
    if (inline !== null && inline.length < MIN_PASSWORD) {
      console.error(`Password must be at least ${MIN_PASSWORD} characters.`);
      process.exit(EXIT_SETUP);
    }
    await setPassword(inline || await promptPassword('New password: '));
    console.log('\nPassword saved. Remembered devices were signed out.');
    return;
  }

  // Issue the laptop's certificate and write the folder to copy to the laptop.
  if (args.includes('--enroll')) {
    const bundle = buildLaptopBundle(path.join(DATA, 'certs'), path.join(DATA, 'enroll'), { regenerate: args.includes('new') });
    config.enrolledClients = [bundle.fingerprint]; // only this laptop from now on
    saveConfig();
    console.log(`\nLaptop certificate ready in:\n  ${bundle.dir}\n`);
    console.log('Copy that folder to the laptop and run install-on-laptop.bat there.');
    console.log(`(.p12 import password, if asked: ${bundle.password})`);
    return;
  }

  if (!config.password) {
    if (!process.stdin.isTTY) {
      log('No password set. Run set-password.bat (or start.bat) once first.');
      process.exit(EXIT_SETUP);
    }
    console.log('\nFirst run: choose the password you will type on the laptop (only once per device).');
    await setPassword(await promptPassword('New password: '));
    console.log('\nPassword saved.\n');
  }
  if (!fs.existsSync(FFMPEG)) {
    log(`ffmpeg not found at ${FFMPEG}. Run install.bat first.`);
    process.exit(EXIT_SETUP);
  }

  configText = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '');
  watchConfig();
  const certDir = path.join(DATA, 'certs');

  // Tailscale's name/IP go into the certificate; detected again on refresh so the
  // cert keeps covering it when Tailscale comes up after the server does.
  const extraNames = () => { const ts = detectTailscale(); return ts ? { dns: ts.name ? [ts.name] : [], ips: [ts.ip] } : { dns: [], ips: [] }; };
  const certs = ensureCertificates(certDir, extraNames());

  // Trust whatever laptop certificate was issued here (install.bat runs --enroll),
  // so a freshly set-up laptop works without a separate step.
  if (certs.clientFingerprint && !config.enrolledClients.includes(certs.clientFingerprint)) {
    config.enrolledClients = [certs.clientFingerprint];
    saveConfig();
  }
  if (!config.enrolledClients.length) {
    log('No laptop certificate enrolled yet — access is password-only. Run install.bat to lock access to one laptop.');
  }

  // requestCert asks the laptop for its certificate; rejectUnauthorized:false lets us
  // answer certless connections with a help page instead of a blank TLS failure.
  const server = https.createServer(
    { key: certs.key, cert: certs.cert, ca: certs.clientCaPem, requestCert: true, rejectUnauthorized: false },
    createHttpHandler(),
  );
  attachWebSocket(server);

  // Re-issue the certificate without a restart when the PC's addresses change
  // (new DHCP lease, or Tailscale connecting after boot).
  let currentCert = certs.cert.toString();
  setInterval(() => {
    try {
      const c = ensureCertificates(certDir, extraNames());
      if (c.cert.toString() !== currentCert) {
        server.setSecureContext({ key: c.key, cert: c.cert, ca: c.clientCaPem, requestCert: true, rejectUnauthorized: false });
        currentCert = c.cert.toString();
        log(`addresses changed, certificate now covers: ${[...c.names.ips, ...c.names.dns].join(', ')}`);
      }
    } catch (e) { log('certificate refresh failed', String(e)); }
  }, 30e3).unref();

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { log(`Port ${config.port} is already in use (is PCRemote already running?)`); process.exit(EXIT_SETUP); }
    if (e.code === 'EADDRNOTAVAIL') { log('bind address not available yet, retrying…'); setTimeout(listen, 4000); return; }
    log(String(e));
  });

  // Choose the interface to listen on. 'tailscale' (default) binds only the Tailscale
  // IP, so the port does not exist on the home LAN or the internet.
  function bindHost() {
    if (config.bind === 'all') return '0.0.0.0';
    if (config.bind === 'lan') return '0.0.0.0'; // firewall limits this to the local subnet
    if (config.allowLan) return '0.0.0.0'; // tailscale + LAN; firewall limits to both
    const ts = detectTailscale(0); // fresh: we're not bound yet, so this is not the hot path
    return ts ? ts.ip : null; // tailscale-only; null => not up yet
  }

  let announced = false;
  function listen() {
    const host = bindHost();
    if (!host) {
      if (!announced) { log('Waiting for Tailscale to connect (open the Tailscale app and sign in)…'); announced = true; }
      setTimeout(listen, 4000);
      return;
    }
    server.listen(config.port, host, () => {
      const ts = detectTailscale();
      const hosts = config.bind === 'tailscale' && !config.allowLan
        ? [ts && ts.name, ts && ts.ip].filter(Boolean)
        : [...certs.names.ips.filter((ip) => ip !== '127.0.0.1'), ts && ts.name].filter(Boolean);
      log(`PCRemote is running (listening on ${host}). Open on the laptop:`);
      for (const h of hosts) log(`   https://${h}:${config.port}`);
      log(`Displays: ${win.listOutputs().map((o) => `#${o.index + 1} ${o.width}x${o.height}${o.primary ? ' (primary)' : ''}`).join(', ')}`);
    });
  }
  listen();

  const shutdown = () => { if (active) active.close('host shutting down'); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((e) => { log('fatal', String(e && e.stack || e)); process.exit(1); });
} else {
  module.exports = { Session, sanitizeSettings }; // for tests
}
