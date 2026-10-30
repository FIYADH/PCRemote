'use strict';
// Decodes the client's compact binary input messages and injects them with SendInput.
// Tracks what is held down so everything can be released if the client vanishes.
//
//   1 MOVE_ABS    [u8 1][u16 x][u16 y]           x,y in 0..65535 across the streamed monitor
//   2 BUTTON      [u8 2][u8 button][u8 down]     button: 0 left, 1 middle, 2 right, 3 back, 4 forward
//   3 WHEEL       [u8 3][i16 dy][i16 dx]         Windows wheel units (120 = one notch), +dy = up
//   4 KEY         [u8 4][u8 down][u16 scan][u8 flags][u8 vk]   flags: 1 extended, 2 use vk instead of scan
//   5 MOVE_REL    [u8 5][i16 dx][i16 dy]
//   6 RELEASE_ALL [u8 6]

const win = require('./win');

const { MOUSE, KEY } = win;
const BUTTONS = [
  { down: MOUSE.LEFTDOWN, up: MOUSE.LEFTUP, data: 0 },
  { down: MOUSE.MIDDLEDOWN, up: MOUSE.MIDDLEUP, data: 0 },
  { down: MOUSE.RIGHTDOWN, up: MOUSE.RIGHTUP, data: 0 },
  { down: MOUSE.XDOWN, up: MOUSE.XUP, data: 1 },
  { down: MOUSE.XDOWN, up: MOUSE.XUP, data: 2 },
];

class InputController {
  constructor() {
    this.rect = null;
    this.vs = win.virtualScreen();
    this.keys = new Map();
    this.buttons = new Set();
  }

  setRect(rect) {
    this.rect = rect;
    this.vs = win.virtualScreen();
  }

  handle(buf) {
    switch (buf[0]) {
      case 1: {
        if (buf.length < 5 || !this.rect) return;
        const r = this.rect;
        const x = r.left + Math.min(r.width - 1, Math.floor(buf.readUInt16LE(1) * r.width / 65535));
        const y = r.top + Math.min(r.height - 1, Math.floor(buf.readUInt16LE(3) * r.height / 65535));
        win.moveAbsolute(x, y, this.vs);
        return;
      }
      case 2: {
        if (buf.length < 3) return;
        const b = BUTTONS[buf[1]];
        if (!b) return;
        const down = buf[2] === 1;
        win.sendMouse(0, 0, b.data, down ? b.down : b.up);
        if (down) this.buttons.add(buf[1]); else this.buttons.delete(buf[1]);
        return;
      }
      case 3: {
        if (buf.length < 5) return;
        const dy = buf.readInt16LE(1), dx = buf.readInt16LE(3);
        if (dy) win.sendMouse(0, 0, dy, MOUSE.WHEEL);
        if (dx) win.sendMouse(0, 0, dx, MOUSE.HWHEEL);
        return;
      }
      case 4: {
        if (buf.length < 6) return;
        const down = buf[1] === 1, scan = buf.readUInt16LE(2), flags = buf[4], vk = buf[5];
        this.key(down, scan, flags, vk);
        const id = `${scan}:${flags}:${vk}`;
        if (down) this.keys.set(id, [scan, flags, vk]); else this.keys.delete(id);
        return;
      }
      case 5: {
        if (buf.length < 5) return;
        win.sendMouse(buf.readInt16LE(1), buf.readInt16LE(3), 0, MOUSE.MOVE);
        return;
      }
      case 6:
        this.releaseAll();
    }
  }

  key(down, scan, flags, vk) {
    const f = ((flags & 1) ? KEY.EXTENDED : 0) | (down ? 0 : KEY.KEYUP);
    if (scan && !(flags & 2)) win.sendKey(0, scan, f | KEY.SCANCODE);
    else if (vk) win.sendKey(vk, 0, f);
  }

  releaseAll() {
    for (const [scan, flags, vk] of this.keys.values()) this.key(false, scan, flags, vk);
    this.keys.clear();
    for (const i of this.buttons) win.sendMouse(0, 0, BUTTONS[i].data, BUTTONS[i].up);
    this.buttons.clear();
  }
}

module.exports = { InputController };
