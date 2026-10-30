import { keyFor } from './keymap.js';
import { t, getLang, setLang, applyI18n } from './i18n.js';

const $ = (id) => document.getElementById(id);
const nowMs = () => performance.timeOrigin + performance.now();

const store = {
  get(k, d) { try { const v = localStorage.getItem('pcr.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('pcr.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem('pcr.' + k); } catch { /* private mode */ } },
};

const canvas = $('screen');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const MOVE_EVENT = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';

const S = {
  ws: null, creds: null, connected: false, session: null, host: '',
  monitors: [], settings: store.get('settings', {}),
  authFailed: false, kicked: false, userClosed: false, retry: 0, retryTimer: null,
  // video
  gen: -1, decoder: null, needKey: true, frameNo: 0, sentTs: new Map(), hwPref: 'prefer-hardware', hwErrors: 0,
  hwLabel: '', video: { w: 0, h: 0 }, rect: null, firstFrame: false,
  // clock
  pingTimer: null, samples: [], clockOffset: 0, clockReady: false, rtt: 0, openedAt: 0, handshakeFails: 0,
  // stats
  frames: 0, bytes: 0, lat: [], statsTimer: null, live: { fps: 0, mbps: 0, lat: 0 },
  // input
  pressed: new Set(), keysDown: new Set(), wheelX: 0, wheelY: 0,
  cursor: store.get('cursor', 'none'), gameMode: false, showStats: store.get('showStats', false),
  // clipboard
  localClip: undefined, pendingClip: null,
};

// ================================================================= views

function showLogin(message) {
  $('remote').hidden = true;
  $('login').hidden = false;
  $('loginError').hidden = !message;
  $('loginError').textContent = message || '';
  setTimeout(() => $('password').focus(), 0);
}

function showRemote() {
  $('login').hidden = true;
  $('remote').hidden = false;
  applyCursor();
  layout();
}

function setStatus(text, { spinner = true, action = null } = {}) {
  const el = $('status');
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('idle', !spinner);
  $('statusText').textContent = text;
  const btn = $('statusAction');
  btn.hidden = !action;
  if (action) { btn.textContent = action.label; btn.onclick = action.run; }
}

function toast(text, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toasts').append(el);
  if (ms) setTimeout(() => el.remove(), ms);
  return el;
}

// ================================================================= connection

function connect(creds) {
  clearTimeout(S.retryTimer);
  S.creds = creds;
  S.authFailed = S.kicked = S.userClosed = false;
  showRemote();
  setStatus(S.retry ? t('reconnecting') : t('connecting'));

  const ws = new WebSocket(`wss://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  S.openedAt = performance.now();
  ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', ...creds, deviceName: deviceName(), settings: S.settings }));
  ws.onmessage = (ev) => {
    if (ws !== S.ws) return;
    if (typeof ev.data === 'string') onControl(JSON.parse(ev.data));
    else onVideoPacket(ev.data);
  };
  ws.onclose = () => { if (ws === S.ws) onClosed(); };
}

function onClosed() {
  const wasConnected = S.connected;
  S.connected = false;
  clearInterval(S.pingTimer);
  clearInterval(S.statsTimer);
  closeDecoder();
  S.pressed.clear();
  S.keysDown.clear();
  updatePanel();
  if (S.authFailed || S.userClosed) return;
  if (S.kicked) {
    setStatus(t('kicked'), { spinner: false, action: { label: t('takeBack'), run: () => connect(S.creds) } });
    return;
  }
  if (wasConnected) S.retry = 0;
  // Handshakes that are refused immediately (e.g. this device's certificate was
  // removed) keep failing the same way — reload so the server can explain why.
  if (!wasConnected && performance.now() - S.openedAt < 1500 && ++S.handshakeFails >= 4) { location.reload(); return; }
  if (wasConnected) S.handshakeFails = 0;
  const delay = Math.min(5000, 400 * 2 ** S.retry++);
  setStatus(t('reconnecting'));
  S.retryTimer = setTimeout(() => connect(S.creds), delay);
}

function send(obj) {
  if (S.connected && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}
function sendBin(buf) {
  if (S.connected && S.ws.readyState === 1) S.ws.send(buf);
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}

function onControl(m) {
  switch (m.t) {
    case 'auth': return onAuth(m);
    case 'video': return configureDecoder(m);
    case 'pong': return onPong(m);
    case 'clip': return onRemoteClip(m.text);
    case 'settings':
      S.settings = m.settings;
      S.monitors = m.monitors;
      store.set('settings', S.settings);
      return updatePanel();
    case 'status':
      if (m.state === 'nocapture') setStatus(t('nocapture'));
      else if (m.state === 'congested') toast(t('congested', { n: m.bitrate }));
      else if (m.state === 'nogamepad') toast(t('noGamepadDriver'), 6000);
      return;
    case 'rumble': return rumble(m);
    case 'kicked':
      S.kicked = true;
      return;
  }
}

function onAuth(m) {
  if (!m.ok) {
    S.authFailed = true;
    S.ws.close();
    if (m.error === 'token') { store.del('deviceToken'); return showLogin(t('errToken')); }
    if (m.error === 'locked') return showLogin(t('errLocked'));
    return showLogin(t('errPassword'));
  }
  if (m.deviceToken) store.set('deviceToken', m.deviceToken);
  const token = store.get('deviceToken', null);
  if (token) S.creds = { deviceToken: token }; // reconnects never need the password again
  S.connected = true;
  S.retry = 0;
  S.session = m.session;
  S.host = m.host;
  S.monitors = m.monitors;
  S.settings = m.settings;
  store.set('settings', S.settings);
  S.firstFrame = false;
  setStatus(t('starting'));
  updatePanel();
  startPings();
  if (!A.on) send({ t: 'audio', on: false });
  S.statsTimer = setInterval(tickStats, 1000);
  primeClipboard();
}

// ================================================================= video

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function closeDecoder() {
  if (S.decoder && S.decoder.state !== 'closed') { try { S.decoder.close(); } catch { /* already closed */ } }
  S.decoder = null;
}

function configureDecoder(m) {
  closeDecoder();
  S.gen = m.gen;
  S.needKey = true;
  S.sentTs.clear();
  if (m.width && m.height) setVideoSize(m.width, m.height);
  const config = {
    codec: m.codec,
    description: b64ToBytes(m.description),
    optimizeForLatency: true,
    hardwareAcceleration: S.hwPref,
  };
  const dec = new VideoDecoder({ output: onFrame, error: (e) => onDecoderError(dec, e) });
  try { dec.configure(config); } catch (e) { onDecoderError(dec, e); return; }
  S.decoder = dec;
  VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-hardware' })
    .then((r) => { S.hwLabel = r.supported && S.hwPref === 'prefer-hardware' ? 'HW' : 'SW'; })
    .catch(() => {});
}

function onDecoderError(dec, e) {
  console.warn('decoder error', e);
  if (S.decoder === dec) S.decoder = null;
  if (S.hwPref === 'prefer-hardware' && (e.name === 'NotSupportedError' || ++S.hwErrors >= 3)) S.hwPref = 'no-preference';
  send({ t: 'keyframe' });
}

// ---- audio: 20 ms PCM chunks scheduled back to back; anything late is dropped, never queued
const A = { ctx: null, next: 0, on: true };
try { A.on = localStorage.getItem('audio') !== 'off'; } catch { /* storage blocked */ }

function audioContext() {
  if (!A.ctx) A.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  if (A.ctx.state === 'suspended') A.ctx.resume().catch(() => {});
  return A.ctx;
}
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => { if (A.on) audioContext(); }, { passive: true });

function playAudio(buf) {
  if (!A.on) return;
  const ctx = audioContext();
  if (ctx.state !== 'running') return;
  const pcm = new Int16Array(buf, 2, (buf.byteLength - 2) >> 1);
  const frames = pcm.length >> 1;
  const ab = ctx.createBuffer(2, frames, 48000);
  const l = ab.getChannelData(0), r = ab.getChannelData(1);
  for (let i = 0; i < frames; i++) { l[i] = pcm[2 * i] / 32768; r[i] = pcm[2 * i + 1] / 32768; }
  const t = ctx.currentTime;
  if (A.next < t + 0.01) A.next = t + 0.04; // underrun: restart with a small cushion
  else if (A.next > t + 0.15) return; // too far ahead: drop to stay in sync with the picture
  const src = ctx.createBufferSource();
  src.buffer = ab;
  src.connect(ctx.destination);
  src.start(A.next);
  A.next += frames / 48000;
}

// ---- gamepads: polled ~125 Hz while one is plugged in, sent only when something changed
const GP_BITS = [0x1000, 0x2000, 0x4000, 0x8000, 0x0100, 0x0200, 0, 0, 0x0020, 0x0010, 0x0040, 0x0080, 0x0001, 0x0002, 0x0004, 0x0008, 0x0400];
const GP = { last: new Map(), timer: null, buf: new DataView(new ArrayBuffer(14)) };
const stick = (v) => Math.max(-32768, Math.min(32767, Math.round((Math.abs(v) < 0.05 ? 0 : v) * 32767)));

function pollGamepads() {
  if (!S.connected) return;
  for (const gp of navigator.getGamepads()) {
    if (!gp || gp.index > 3) continue;
    let buttons = 0;
    gp.buttons.forEach((b, i) => { if (b.pressed && GP_BITS[i]) buttons |= GP_BITS[i]; });
    const a = gp.axes;
    const v = [buttons, Math.round((gp.buttons[6]?.value || 0) * 255), Math.round((gp.buttons[7]?.value || 0) * 255),
      stick(a[0] || 0), stick(-(a[1] || 0)), stick(a[2] || 0), stick(-(a[3] || 0))];
    const key = v.join(',');
    if (GP.last.get(gp.index) === key) continue;
    GP.last.set(gp.index, key);
    const d = GP.buf;
    d.setUint8(0, 7); d.setUint8(1, gp.index); d.setUint16(2, v[0], true); d.setUint8(4, v[1]); d.setUint8(5, v[2]);
    d.setInt16(6, v[3], true); d.setInt16(8, v[4], true); d.setInt16(10, v[5], true); d.setInt16(12, v[6], true);
    sendBin(d.buffer);
  }
}
addEventListener('gamepadconnected', (e) => {
  toast(t('gamepadOn', { name: e.gamepad.id.replace(/\s*\(.*\)\s*/g, '') || 'Gamepad' }));
  if (!GP.timer) GP.timer = setInterval(pollGamepads, 8);
});
addEventListener('gamepaddisconnected', (e) => {
  GP.last.delete(e.gamepad.index);
  sendBin(new Uint8Array([8, e.gamepad.index]));
  if (![...navigator.getGamepads()].some(Boolean)) { clearInterval(GP.timer); GP.timer = null; }
});

function rumble({ slot, large, small }) {
  const act = navigator.getGamepads()[slot]?.vibrationActuator;
  if (!act) return;
  if (!large && !small) { act.reset?.(); return; }
  act.playEffect('dual-rumble', { duration: 5000, strongMagnitude: large / 255, weakMagnitude: small / 255 }).catch(() => {});
}

function setAudio(on) {
  A.on = on;
  try { localStorage.setItem('audio', on ? 'on' : 'off'); } catch { /* storage blocked */ }
  if (on) audioContext();
  send({ t: 'audio', on });
  updatePanel();
}

function onVideoPacket(buf) {
  S.bytes += buf.byteLength;
  const dv = new DataView(buf);
  if (dv.getUint8(0) === 2) return playAudio(buf);
  if (dv.getUint8(0) !== 1) return;
  const key = dv.getUint8(1) & 1;
  const dec = S.decoder;
  if (dv.getUint16(2, true) !== S.gen || !dec || dec.state !== 'configured') return;
  if (S.needKey) {
    if (!key) return;
    S.needKey = false;
  }
  if (dec.decodeQueueSize > 10) { // decoder fell behind: skip to a fresh keyframe to stay low-latency
    S.needKey = true;
    send({ t: 'keyframe' });
    return;
  }
  const timestamp = S.frameNo++ * 1000;
  S.sentTs.set(timestamp, dv.getFloat64(4, true));
  dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data: new Uint8Array(buf, 12) }));
}

function onFrame(frame) {
  const sent = S.sentTs.get(frame.timestamp);
  S.sentTs.delete(frame.timestamp);
  if (frame.displayWidth !== S.video.w || frame.displayHeight !== S.video.h) setVideoSize(frame.displayWidth, frame.displayHeight);
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  frame.close();
  S.frames++;
  if (sent !== undefined && S.clockReady) S.lat.push(nowMs() + S.clockOffset - sent);
  if (S.sentTs.size > 240) S.sentTs.clear();
  if (!S.firstFrame) {
    S.firstFrame = true;
    setStatus(null);
  } else if (!$('status').hidden && !S.kicked) {
    setStatus(null);
  }
}

function setVideoSize(w, h) {
  S.video = { w, h };
  layout();
}

// Render at the canvas's real device-pixel size: 1:1 when sizes match (sharpest),
// otherwise a high-quality scale done once per frame by the GPU.
function layout() {
  const { w, h } = S.video;
  if (!w || $('remote').hidden) return;
  const stage = $('stage');
  const scale = Math.min(stage.clientWidth / w, stage.clientHeight / h);
  const dpr = window.devicePixelRatio || 1;
  let pw = Math.round(w * scale * dpr), ph = Math.round(h * scale * dpr);
  if (Math.abs(pw - w) <= 2 && Math.abs(ph - h) <= 2) { pw = w; ph = h; }
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  canvas.style.width = pw / dpr + 'px';
  canvas.style.height = ph / dpr + 'px';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  S.rect = canvas.getBoundingClientRect();
}
window.addEventListener('resize', layout);
document.addEventListener('fullscreenchange', () => { layout(); updatePanel(); });

// ================================================================= clock & stats

function startPings() {
  clearInterval(S.pingTimer);
  S.samples = [];
  S.clockReady = false;
  const ping = () => send({ t: 'ping', c: nowMs() });
  ping();
  setTimeout(ping, 150);
  S.pingTimer = setInterval(ping, 1000);
}

function onPong(m) {
  const t1 = nowMs();
  S.rtt = t1 - m.c;
  S.samples.push({ rtt: S.rtt, offset: m.s - (m.c + t1) / 2 });
  if (S.samples.length > 20) S.samples.shift();
  // The lowest-RTT sample has the least asymmetric delay, so its offset is the most accurate.
  S.clockOffset = S.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
  S.clockReady = true;
}

function tickStats() {
  const lat = S.lat.sort((a, b) => a - b);
  S.live = {
    fps: S.frames,
    mbps: S.bytes * 8 / 1e6,
    lat: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
  };
  S.frames = 0; S.bytes = 0; S.lat = [];
  const { fps, mbps, lat: l } = S.live;
  const line = `${fps} fps · ${mbps.toFixed(1)} Mbps · ${Math.max(0, l).toFixed(0)} ms`;
  $('liveLine').textContent = line;
  $('stats').textContent = `${line} · RTT ${S.rtt.toFixed(1)} ms · ${S.video.w}×${S.video.h} · ${S.hwLabel || '…'}`;
}

// ================================================================= input: mouse

const absBuf = new DataView(new ArrayBuffer(5));
const relBuf = new DataView(new ArrayBuffer(5));
const btnBuf = new Uint8Array(3);
const wheelBuf = new DataView(new ArrayBuffer(5));
const clamp16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
const pointerLocked = () => document.pointerLockElement === canvas;

function sendAbs(e) {
  const r = S.rect || canvas.getBoundingClientRect();
  if (!r.width) return;
  const nx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  const ny = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  absBuf.setUint8(0, 1);
  absBuf.setUint16(1, Math.round(nx * 65535), true);
  absBuf.setUint16(3, Math.round(ny * 65535), true);
  sendBin(absBuf.buffer);
}

window.addEventListener(MOVE_EVENT, (e) => {
  if (!S.connected) return;
  if (pointerLocked()) {
    if (!e.movementX && !e.movementY) return;
    relBuf.setUint8(0, 5);
    relBuf.setInt16(1, clamp16(e.movementX), true);
    relBuf.setInt16(3, clamp16(e.movementY), true);
    sendBin(relBuf.buffer);
  } else if (e.target === canvas || S.pressed.size) {
    sendAbs(e);
  }
}, { passive: true });

function sendButton(button, down) {
  btnBuf[0] = 2; btnBuf[1] = button; btnBuf[2] = down ? 1 : 0;
  sendBin(btnBuf);
}

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  if (!S.connected) return;
  if (panelOpen()) { openPop(null); return; } // first click just closes the popover
  if (TB.shown && !UI.pin) togglePanel(false);
  if (S.pendingClip) flushPendingClip();
  if (S.gameMode && !pointerLocked()) { lockPointer(); return; }
  if (e.button > 4) return;
  if (!pointerLocked()) sendAbs(e);
  S.pressed.add(e.button);
  sendButton(e.button, true);
});
window.addEventListener('mouseup', (e) => {
  if (!S.pressed.has(e.button)) return;
  S.pressed.delete(e.button);
  sendButton(e.button, false);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('auxclick', (e) => e.preventDefault());

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!S.connected) return;
  // Pixel deltas: Chrome reports 100px per notch -> Windows' 120 units. Lines: 40 units each.
  const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 360 : 1.2;
  S.wheelY += -e.deltaY * k;
  S.wheelX += e.deltaX * k;
  const dy = Math.trunc(S.wheelY), dx = Math.trunc(S.wheelX);
  S.wheelY -= dy; S.wheelX -= dx;
  if (!dy && !dx) return;
  wheelBuf.setUint8(0, 3);
  wheelBuf.setInt16(1, clamp16(dy), true);
  wheelBuf.setInt16(3, clamp16(dx), true);
  sendBin(wheelBuf.buffer);
}, { passive: false });

function lockPointer() {
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(() => canvas.requestPointerLock());
  } catch { canvas.requestPointerLock(); }
}
document.addEventListener('pointerlockchange', () => {
  if (!pointerLocked() && S.gameMode && S.connected) toast(t('clickForGame'));
});

// ================================================================= input: keyboard

const keyBuf = new Uint8Array(6);
function sendKey(k, down) {
  keyBuf[0] = 4; keyBuf[1] = down ? 1 : 0;
  keyBuf[2] = k.scan & 0xff; keyBuf[3] = k.scan >> 8;
  keyBuf[4] = k.flags; keyBuf[5] = k.vk;
  sendBin(keyBuf);
}

function releaseAll() {
  sendBin(new Uint8Array([6]));
  S.keysDown.clear();
  S.pressed.clear();
}

const isFormField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

function onKey(e) {
  if (!S.connected || $('remote').hidden || isFormField(e.target) || e.isComposing) return;
  const down = e.type === 'keydown';
  if (down && e.code === 'KeyM' && e.ctrlKey && e.altKey && e.shiftKey) {
    e.preventDefault();
    releaseAll();
    if (pointerLocked()) document.exitPointerLock();
    togglePanel();
    clearTimeout(TB.hideTimer); // opened from the keyboard: stay until dismissed
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  if (down && S.pendingClip) flushPendingClip();
  const k = keyFor(e.code, e.keyCode);
  if (!k) return;
  if (down) S.keysDown.add(e.code);
  else if (!S.keysDown.delete(e.code)) return; // never send an up for a key we didn't send down
  sendKey(k, down);
}
window.addEventListener('keydown', onKey, true);
window.addEventListener('keyup', onKey, true);

const COMBOS = {
  win: ['MetaLeft'],
  alttab: ['AltLeft', 'Tab'],
  taskmgr: ['ControlLeft', 'ShiftLeft', 'Escape'],
  altf4: ['AltLeft', 'F4'],
  desktop: ['MetaLeft', 'KeyD'],
  explorer: ['MetaLeft', 'KeyE'],
  snip: ['MetaLeft', 'ShiftLeft', 'KeyS'],
  lang: ['AltLeft', 'ShiftLeft'],
};
function tapCombo(name) {
  const keys = COMBOS[name].map((c) => keyFor(c));
  keys.forEach((k) => sendKey(k, true));
  keys.slice().reverse().forEach((k) => sendKey(k, false));
}

// Losing focus mid-keypress would leave keys stuck down on the PC.
window.addEventListener('blur', () => { if (S.connected) releaseAll(); });
document.addEventListener('visibilitychange', () => {
  if (!S.connected) return;
  if (document.hidden) { releaseAll(); send({ t: 'pause' }); }
  else { S.firstFrame = false; send({ t: 'resume' }); }
});
window.addEventListener('beforeunload', (e) => {
  if (S.connected) { e.preventDefault(); e.returnValue = ''; }
});

// ================================================================= clipboard

async function readLocalClip() {
  try { return await navigator.clipboard.readText(); } catch { return undefined; }
}

// Learn the laptop's current clipboard without pushing it, so connecting never clobbers the PC's.
async function primeClipboard() {
  const text = await readLocalClip();
  if (text !== undefined) S.localClip = text;
}

async function onFocusClipboard() {
  if (!S.connected) return;
  const text = await readLocalClip();
  if (text === undefined) return;
  if (text !== S.localClip) {
    S.localClip = text;
    S.pendingClip = null;
    if (text && text.length <= 2e6) send({ t: 'clip', text });
  } else if (S.pendingClip) {
    flushPendingClip();
  }
}
window.addEventListener('focus', onFocusClipboard);

function onRemoteClip(text) {
  navigator.clipboard.writeText(text)
    .then(() => { S.localClip = text; S.pendingClip = null; })
    .catch(() => { S.pendingClip = text; });
}
function flushPendingClip() {
  const text = S.pendingClip;
  navigator.clipboard.writeText(text).then(() => { S.localClip = text; if (S.pendingClip === text) S.pendingClip = null; }).catch(() => {});
}

// ================================================================= file upload

function uploadFiles(files) {
  for (const file of files) {
    const tt = toast(t('sending', { name: file.name, p: 0 }), 0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.setRequestHeader('x-session', S.session || '');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) tt.textContent = t('sending', { name: file.name, p: Math.round(e.loaded / e.total * 100) }); };
    xhr.onload = () => {
      tt.remove();
      if (xhr.status === 200) toast(t('sent', { path: JSON.parse(xhr.responseText).path }), 6000);
      else toast(t('sendFailed', { name: file.name }));
    };
    xhr.onerror = () => { tt.remove(); toast(t('sendFailed', { name: file.name })); };
    xhr.send(file);
  }
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (!S.connected) return; e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  if (S.connected && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

// ================================================================= panel

// ---- look & feel, kept per laptop
const ACCENTS = ['#3B82F6', '#6366F1', '#A855F7', '#EC4899', '#EF4444', '#F97316', '#EAB308', '#22C55E', '#14B8A6', '#71717A'];
let UI = { accent: '#3B82F6', theme: 'dark', pin: false, ...store.get('ui', {}) };
if (!ACCENTS.includes(UI.accent)) UI.accent = ACCENTS[0];

function applyUi() {
  const r = document.documentElement;
  r.dataset.theme = UI.theme;
  r.style.setProperty('--accent', UI.accent);
}
function setUi(patch) {
  UI = { ...UI, ...patch };
  store.set('ui', UI);
  applyUi();
  updatePanel();
}

// Segmented controls get one thumb that slides to the selected option.
function syncSegs() {
  for (const seg of document.querySelectorAll('.seg')) {
    const on = seg.querySelector('button.on');
    let thumb = seg.querySelector('.seg-thumb');
    if (!on) { thumb?.remove(); continue; }
    if (!thumb) {
      thumb = document.createElement('span');
      thumb.className = 'seg-thumb';
      thumb.style.transition = 'none';
      seg.prepend(thumb);
      requestAnimationFrame(() => { thumb.style.transition = ''; });
    }
    thumb.style.width = `${on.offsetWidth}px`;
    thumb.style.transform = `translateX(${on.offsetLeft}px)`;
  }
}
const fillRange = (el) => el.style.setProperty('--fill', `${(el.value - el.min) / (el.max - el.min) * 100}%`);

// ---- floating toolbar: slides in near the top edge, hides itself when idle unless pinned
const TB = { shown: false, pop: null, hideTimer: null, hover: false };
const panelOpen = () => !!TB.pop;

function togglePanel(open = !TB.shown) {
  TB.shown = open;
  $('toolbar').classList.toggle('shown', open);
  if (!open) { openPop(null); hideTip(); }
  else { updatePanel(); scheduleHide(); }
}

function scheduleHide() {
  clearTimeout(TB.hideTimer);
  if (UI.pin || !TB.shown) return;
  TB.hideTimer = setTimeout(() => { if (!TB.hover && !TB.pop) togglePanel(false); }, 1600);
}

function openPop(id) {
  const prev = TB.pop;
  if (prev) {
    $(prev).classList.remove('open');
    $(prev).inert = true;
    document.querySelector(`[data-pop="${prev}"]`)?.classList.remove('active');
  }
  TB.pop = id && id !== prev ? id : null;
  if (!TB.pop) { scheduleHide(); return; }
  const pop = $(TB.pop);
  const btn = document.querySelector(`[data-pop="${TB.pop}"]`);
  btn.classList.add('active');
  hideTip();
  updatePanel();
  positionPop();
  pop.inert = false;
  pop.classList.add('open');
  syncSegs();
}

function positionPop() {
  if (!TB.pop) return;
  const pop = $(TB.pop);
  const b = document.querySelector(`[data-pop="${TB.pop}"]`).getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = `${$('toolbar').getBoundingClientRect().bottom + 8}px`;
  pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, b.left + b.width / 2 - w / 2))}px`;
}

function showTip(el) {
  if (TB.pop && el.dataset.pop === TB.pop) return;
  const tip = $('tip');
  tip.textContent = t(el.dataset.tip);
  const r = el.getBoundingClientRect();
  tip.style.top = `${r.bottom + 8}px`;
  tip.style.left = `${Math.max(6, Math.min(innerWidth - tip.offsetWidth - 6, r.left + r.width / 2 - tip.offsetWidth / 2))}px`;
  tip.classList.add('show');
}
function hideTip() { $('tip').classList.remove('show'); }

function applyTips() {
  for (const el of document.querySelectorAll('[data-tip]')) el.setAttribute('aria-label', t(el.dataset.tip));
}

function applySettings(patch) {
  S.settings = { ...S.settings, ...patch };
  store.set('settings', S.settings);
  S.firstFrame = false;
  send({ t: 'settings', settings: S.settings });
  updatePanel();
}

function applyCursor() {
  canvas.classList.toggle('cursor-none', S.cursor === 'none');
  canvas.classList.toggle('cursor-dot', S.cursor === 'dot');
}

function updatePanel() {
  $('connDot').classList.toggle('ok', S.connected);
  $('hostName').textContent = S.connected ? S.host : t('notConnected');
  const seg = $('monitorSeg');
  seg.replaceChildren(...S.monitors.map((m, i) => {
    const b = document.createElement('button');
    b.textContent = t('monitorN', { n: i + 1 }) + (m.primary ? t('primary') : '');
    b.title = `${m.width}×${m.height}`;
    b.classList.toggle('on', m.index === S.settings.monitor);
    b.onclick = () => applySettings({ monitor: m.index });
    return b;
  }));
  for (const b of $('qualitySeg').children) b.classList.toggle('on', b.dataset.q === S.settings.quality);
  for (const b of $('fpsSeg').children) b.classList.toggle('on', Number(b.dataset.fps) === S.settings.fps);
  $('bitrate').value = S.settings.maxBitrate || 40;
  $('bitrateVal').textContent = `${S.settings.maxBitrate || 40} Mbps`;
  $('audioBtn').classList.toggle('off', !A.on);
  $('cursorBtn').classList.toggle('on', S.cursor === 'dot');
  $('gameBtn').classList.toggle('on', S.gameMode);
  $('statsBtn').classList.toggle('on', S.showStats);
  $('pinBtn').classList.toggle('on', UI.pin);
  for (const b of document.querySelectorAll('[data-lang]')) b.classList.toggle('on', b.dataset.lang === getLang());
  for (const b of $('themeSeg').children) b.classList.toggle('on', b.dataset.theme === UI.theme);
  for (const b of $('accentPick').children) b.classList.toggle('on', b.dataset.accent === UI.accent);
  fillRange($('bitrate'));
  const fs = !!document.fullscreenElement;
  $('fullscreenBtn').classList.toggle('off', fs);
  $('fullscreenBtn').dataset.tip = fs ? 'exitFullscreen' : 'fullscreen';
  $('stats').hidden = !S.showStats;
  syncSegs();
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    // In fullscreen, Keyboard Lock lets Win, Alt+Tab, Esc, Ctrl+W… reach the PC instead of the laptop.
    try { await navigator.keyboard?.lock(); } catch { /* not supported */ }
    toast(t('fsHint'));
  } else {
    navigator.keyboard?.unlock();
    await document.exitFullscreen().catch(() => {});
  }
}

$('dockHandle').addEventListener('click', () => togglePanel(true));
$('dockHandle').addEventListener('mouseenter', () => togglePanel(true));
for (const b of document.querySelectorAll('[data-pop]')) b.addEventListener('click', () => openPop(b.dataset.pop));
for (const el of document.querySelectorAll('[data-tip]')) {
  el.addEventListener('mouseenter', () => showTip(el));
  el.addEventListener('mouseleave', hideTip);
}
// Hovering the toolbar or an open popover keeps it up; leaving starts the auto-hide timer.
for (const el of [$('toolbar'), ...document.querySelectorAll('.pop')]) {
  el.addEventListener('mouseenter', () => { TB.hover = true; clearTimeout(TB.hideTimer); });
  el.addEventListener('mouseleave', () => { TB.hover = false; scheduleHide(); });
}
// Touching the top edge brings the toolbar in (not while the mouse is captured for games).
window.addEventListener('pointermove', (e) => {
  if (!TB.shown && e.clientY <= 2 && !pointerLocked() && S.connected) togglePanel(true);
}, { passive: true });
$('pinBtn').addEventListener('click', () => { setUi({ pin: !UI.pin }); scheduleHide(); });
for (const seg of document.querySelectorAll('[data-lang-seg]')) {
  seg.addEventListener('click', (e) => { const l = e.target.dataset.lang; if (l) { setLang(l); applyTips(); updatePanel(); } });
}
$('qualitySeg').addEventListener('click', (e) => { const q = e.target.dataset.q; if (q) applySettings({ quality: q }); });
$('fpsSeg').addEventListener('click', (e) => { const f = Number(e.target.dataset.fps); if (f) applySettings({ fps: f }); });
$('bitrate').addEventListener('input', () => { $('bitrateVal').textContent = `${$('bitrate').value} Mbps`; fillRange($('bitrate')); });
$('accentPick').replaceChildren(...ACCENTS.map((c) => {
  const b = document.createElement('button');
  b.dataset.accent = c;
  b.style.setProperty('--c', c);
  b.setAttribute('aria-label', c);
  return b;
}));
$('accentPick').addEventListener('click', (e) => { const c = e.target.dataset.accent; if (c) setUi({ accent: c }); });
$('themeSeg').addEventListener('click', (e) => { const v = e.target.dataset.theme; if (v) setUi({ theme: v }); });
addEventListener('resize', () => { positionPop(); syncSegs(); });
$('bitrate').addEventListener('change', () => { applySettings({ maxBitrate: Number($('bitrate').value) }); $('bitrate').blur(); });
$('audioBtn').addEventListener('click', () => setAudio(!A.on));
$('cursorBtn').addEventListener('click', () => { S.cursor = S.cursor === 'none' ? 'dot' : 'none'; store.set('cursor', S.cursor); applyCursor(); updatePanel(); });
$('gameBtn').addEventListener('click', () => {
  S.gameMode = !S.gameMode;
  updatePanel();
  if (S.gameMode) { togglePanel(false); toast(t('gameHint')); }
  else if (pointerLocked()) document.exitPointerLock();
});
document.querySelector('.keys').addEventListener('click', (e) => { const c = e.target.dataset.combo; if (c) tapCombo(c); });
$('fullscreenBtn').addEventListener('click', toggleFullscreen);
$('uploadBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => { uploadFiles($('fileInput').files); $('fileInput').value = ''; });
$('statsBtn').addEventListener('click', () => { S.showStats = !S.showStats; store.set('showStats', S.showStats); updatePanel(); });
$('disconnectBtn').addEventListener('click', () => {
  S.userClosed = true;
  releaseAll();
  S.ws.close();
  togglePanel(false);
  setStatus(t('disconnected'), { spinner: false, action: { label: t('connect'), run: () => connect(S.creds) } });
});
$('forgetBtn').addEventListener('click', () => {
  send({ t: 'forget' });
  store.del('deviceToken');
  S.userClosed = true;
  S.ws.close();
  showLogin();
});
// Toolbar buttons must not keep focus, or Space/Enter meant for the PC would click them.
for (const el of [$('toolbar'), ...document.querySelectorAll('.pop')]) {
  el.addEventListener('click', (e) => { e.target.closest('button')?.blur(); });
}

// ================================================================= boot

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const password = $('password').value;
  $('password').value = '';
  connect({ password, remember: $('remember').checked });
});

function boot() {
  applyUi();
  applyI18n();
  applyTips();
  updatePanel();
  if (!window.isSecureContext || !('VideoDecoder' in window)) {
    showLogin();
    $('loginForm').hidden = true;
    $('unsupported').hidden = false;
    $('unsupported').textContent = window.isSecureContext ? t('noWebCodecs') : t('needHttps');
    return;
  }
  const token = store.get('deviceToken', null);
  if (token) connect({ deviceToken: token });
  else showLogin();
}
boot();
