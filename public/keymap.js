// KeyboardEvent.code -> Windows set-1 scancode [scan, extended].
// Scancodes are layout-independent: the PC's active keyboard language decides the character.
const SCAN = {
  Escape: [0x01], Digit1: [0x02], Digit2: [0x03], Digit3: [0x04], Digit4: [0x05], Digit5: [0x06],
  Digit6: [0x07], Digit7: [0x08], Digit8: [0x09], Digit9: [0x0a], Digit0: [0x0b], Minus: [0x0c],
  Equal: [0x0d], Backspace: [0x0e], Tab: [0x0f],
  KeyQ: [0x10], KeyW: [0x11], KeyE: [0x12], KeyR: [0x13], KeyT: [0x14], KeyY: [0x15], KeyU: [0x16],
  KeyI: [0x17], KeyO: [0x18], KeyP: [0x19], BracketLeft: [0x1a], BracketRight: [0x1b], Enter: [0x1c],
  ControlLeft: [0x1d], KeyA: [0x1e], KeyS: [0x1f], KeyD: [0x20], KeyF: [0x21], KeyG: [0x22],
  KeyH: [0x23], KeyJ: [0x24], KeyK: [0x25], KeyL: [0x26], Semicolon: [0x27], Quote: [0x28],
  Backquote: [0x29], ShiftLeft: [0x2a], Backslash: [0x2b], KeyZ: [0x2c], KeyX: [0x2d], KeyC: [0x2e],
  KeyV: [0x2f], KeyB: [0x30], KeyN: [0x31], KeyM: [0x32], Comma: [0x33], Period: [0x34], Slash: [0x35],
  ShiftRight: [0x36], NumpadMultiply: [0x37], AltLeft: [0x38], Space: [0x39], CapsLock: [0x3a],
  F1: [0x3b], F2: [0x3c], F3: [0x3d], F4: [0x3e], F5: [0x3f], F6: [0x40], F7: [0x41], F8: [0x42],
  F9: [0x43], F10: [0x44], ScrollLock: [0x46], Numpad7: [0x47], Numpad8: [0x48], Numpad9: [0x49],
  NumpadSubtract: [0x4a], Numpad4: [0x4b], Numpad5: [0x4c], Numpad6: [0x4d], NumpadAdd: [0x4e],
  Numpad1: [0x4f], Numpad2: [0x50], Numpad3: [0x51], Numpad0: [0x52], NumpadDecimal: [0x53],
  IntlBackslash: [0x56], F11: [0x57], F12: [0x58], NumpadEqual: [0x59],
  F13: [0x64], F14: [0x65], F15: [0x66], F16: [0x67], F17: [0x68], F18: [0x69], F19: [0x6a],
  F20: [0x6b], F21: [0x6c], F22: [0x6d], F23: [0x6e], F24: [0x76],
  KanaMode: [0x70], IntlRo: [0x73], Convert: [0x79], NonConvert: [0x7b], IntlYen: [0x7d], NumpadComma: [0x7e],
  NumpadEnter: [0x1c, 1], ControlRight: [0x1d, 1], NumpadDivide: [0x35, 1], PrintScreen: [0x37, 1],
  AltRight: [0x38, 1], Home: [0x47, 1], ArrowUp: [0x48, 1], PageUp: [0x49, 1], ArrowLeft: [0x4b, 1],
  ArrowRight: [0x4d, 1], End: [0x4f, 1], ArrowDown: [0x50, 1], PageDown: [0x51, 1], Insert: [0x52, 1],
  Delete: [0x53, 1], MetaLeft: [0x5b, 1], MetaRight: [0x5c, 1], ContextMenu: [0x5d, 1],
};

// Keys that behave more reliably as virtual-key codes [vk, extended].
const VK = {
  NumLock: [0x90, 1], Pause: [0x13, 0],
  AudioVolumeMute: [0xad, 1], AudioVolumeDown: [0xae, 1], AudioVolumeUp: [0xaf, 1],
  MediaTrackNext: [0xb0, 1], MediaTrackPrevious: [0xb1, 1], MediaStop: [0xb2, 1], MediaPlayPause: [0xb3, 1],
  BrowserBack: [0xa6, 1], BrowserForward: [0xa7, 1], BrowserRefresh: [0xa8, 1], BrowserHome: [0xac, 1],
  Lang1: [0x15, 0], Lang2: [0x19, 0],
};

// Returns { scan, flags, vk } for the wire format (flags: 1 extended, 2 use vk).
export function keyFor(code, keyCode = 0) {
  const s = SCAN[code];
  if (s) return { scan: s[0], flags: s[1] ? 1 : 0, vk: 0 };
  const v = VK[code];
  if (v) return { scan: 0, flags: 2 | (v[1] ? 1 : 0), vk: v[0] };
  if (keyCode > 0 && keyCode < 255) return { scan: 0, flags: 2, vk: keyCode };
  return null;
}
