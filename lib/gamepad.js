'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const EXE = path.join(__dirname, '..', 'bin', 'gamepad.exe');

// Laptop gamepads -> virtual Xbox 360 controllers on the PC.
// Binary messages: [7, slot, buttons u16, lt u8, rt u8, lx i16, ly i16, rx i16, ry i16] = state, [8, slot] = unplugged.
// Emits 'rumble' (slot, large, small) and 'nodriver' once if ViGEmBus is missing.
class GamepadBridge extends EventEmitter {
  constructor() { super(); this.proc = null; this.noDriver = false; }

  ensure() {
    if (this.proc || this.noDriver) return this.proc;
    if (!fs.existsSync(EXE)) { this.noDriver = true; this.emit('nodriver'); return null; }
    const proc = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc = proc;
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const p = buf.slice(0, i).trim().split(' ');
        buf = buf.slice(i + 1);
        if (p[0] === 'f') this.emit('rumble', Number(p[1]), Number(p[2]), Number(p[3]));
      }
    });
    proc.stdin.on('error', () => {});
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      if (code === 3) { this.noDriver = true; this.emit('nodriver'); }
    });
    return proc;
  }

  handle(buf) {
    const slot = buf[1];
    if (slot > 3) return;
    if (buf[0] === 8) { if (this.proc) this.proc.stdin.write(`r ${slot}\n`); return; }
    if (buf[0] !== 7 || buf.length < 14) return;
    const proc = this.ensure();
    if (!proc) return;
    const line = `s ${slot} ${buf.readUInt16LE(2)} ${buf[4]} ${buf[5]} ${buf.readInt16LE(6)} ${buf.readInt16LE(8)} ${buf.readInt16LE(10)} ${buf.readInt16LE(12)}\n`;
    proc.stdin.write(line);
  }

  stop() {
    if (this.proc) { try { this.proc.stdin.end(); this.proc.kill(); } catch { /* gone */ } this.proc = null; }
  }
}

module.exports = { GamepadBridge };
