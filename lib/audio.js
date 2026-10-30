'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const SRC = path.join(__dirname, 'audiocap.cs');
const EXE = path.join(__dirname, '..', 'bin', 'audiocap.exe');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const CHUNK = 48000 * 4 / 100 * 2; // 20 ms of 48 kHz 16-bit stereo

function ensureBuilt() {
  if (fs.existsSync(EXE) && fs.statSync(EXE).mtimeMs >= fs.statSync(SRC).mtimeMs) return true;
  try {
    fs.mkdirSync(path.dirname(EXE), { recursive: true });
    execFileSync(CSC, ['/nologo', '/optimize', '/target:exe', `/out:${EXE}`, SRC], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// Emits 'data' with ~20 ms PCM chunks (48 kHz, s16le, stereo) of whatever the PC is playing.
class AudioCapture extends EventEmitter {
  constructor() { super(); this.proc = null; this.stopped = true; this.pending = Buffer.alloc(0); this.retry = null; }

  start() {
    this.stopped = false;
    if (this.proc || !ensureBuilt()) return;
    const proc = spawn(EXE, [], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    this.proc = proc;
    proc.stdout.on('data', (d) => {
      this.pending = this.pending.length ? Buffer.concat([this.pending, d]) : d;
      while (this.pending.length >= CHUNK) {
        this.emit('data', this.pending.subarray(0, CHUNK));
        this.pending = this.pending.subarray(CHUNK);
      }
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      this.pending = Buffer.alloc(0);
      if (!this.stopped) this.retry = setTimeout(() => this.start(), 500); // default output device changed
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    if (this.proc) { try { this.proc.kill(); } catch { /* already gone */ } this.proc = null; }
  }
}

module.exports = { AudioCapture };
