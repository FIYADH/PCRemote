'use strict';
// Thin Win32 layer (via koffi): DPI awareness, DXGI output enumeration,
// SendInput injection, clipboard text, and keep-awake.

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dxgi = koffi.load('dxgi.dll');

// ---------------------------------------------------------------- DPI

const SetProcessDpiAwarenessContext = user32.func('int __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const SetProcessDPIAware = user32.func('int __stdcall SetProcessDPIAware()');
const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4;

// Must run before anything queries coordinates, so everything is in physical pixels.
function makeDpiAware() {
  try {
    if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) return;
  } catch { /* older Windows */ }
  SetProcessDPIAware();
}

// ---------------------------------------------------------------- DXGI outputs
// ddagrab's output_idx indexes the outputs of DXGI adapter 0, so we enumerate the
// exact same list to learn each output's desktop rectangle.

const CreateDXGIFactory1 = dxgi.func('long __stdcall CreateDXGIFactory1(void *riid, _Out_ void **factory)');
const ComEnum = koffi.proto('long __stdcall ComEnum(void *self, uint32_t index, _Out_ void **out)');
const ComGetDesc = koffi.proto('long __stdcall ComGetDesc(void *self, void *desc)');
const ComRelease = koffi.proto('uint32_t __stdcall ComRelease(void *self)');

function guid(str) {
  const h = str.replace(/-/g, '');
  const b = Buffer.alloc(16);
  b.writeUInt32LE(parseInt(h.slice(0, 8), 16), 0);
  b.writeUInt16LE(parseInt(h.slice(8, 12), 16), 4);
  b.writeUInt16LE(parseInt(h.slice(12, 16), 16), 6);
  Buffer.from(h.slice(16), 'hex').copy(b, 8);
  return b;
}
const IID_IDXGIFactory1 = guid('770aae78-f26f-4dba-a829-253c83d1b387');

function vcall(obj, slot, proto, ...args) {
  const vtbl = koffi.decode(obj, 'void *');
  const fn = koffi.decode(vtbl, slot * 8, 'void *');
  return koffi.call(fn, proto, obj, ...args);
}
const release = (obj) => vcall(obj, 2, ComRelease);

// Slot 7 is the first method after IUnknown (3) + IDXGIObject (4) on all three
// interfaces: IDXGIFactory::EnumAdapters, IDXGIAdapter::EnumOutputs, IDXGIOutput::GetDesc.
function listOutputs() {
  const fac = [null];
  if (CreateDXGIFactory1(IID_IDXGIFactory1, fac) < 0) return [];
  const outputs = [];
  try {
    const ad = [null];
    if (vcall(fac[0], 7, ComEnum, 0, ad) < 0) return [];
    try {
      for (let i = 0; i < 16; i++) {
        const out = [null];
        if (vcall(ad[0], 7, ComEnum, i, out) < 0) break;
        const desc = Buffer.alloc(96); // DXGI_OUTPUT_DESC
        try { vcall(out[0], 7, ComGetDesc, desc); } finally { release(out[0]); }
        const left = desc.readInt32LE(64), top = desc.readInt32LE(68);
        const right = desc.readInt32LE(72), bottom = desc.readInt32LE(76);
        outputs.push({
          index: i,
          device: desc.toString('utf16le', 0, 64).replace(/\0[\s\S]*$/, ''),
          left, top, width: right - left, height: bottom - top,
          primary: left === 0 && top === 0,
        });
      }
    } finally { release(ad[0]); }
  } finally { release(fac[0]); }
  return outputs;
}

// ---------------------------------------------------------------- input

const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, void *inputs, int size)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
const GetCursorPos = user32.func('int __stdcall GetCursorPos(void *point)');

const INPUT_SIZE = 40; // sizeof(INPUT) on x64
const INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
const MOUSE = {
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, XDOWN: 0x0080, XUP: 0x0100,
  WHEEL: 0x0800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000,
};
const KEY = { EXTENDED: 0x0001, KEYUP: 0x0002, UNICODE: 0x0004, SCANCODE: 0x0008 };

const inputBuf = Buffer.alloc(INPUT_SIZE);

function sendMouse(dx, dy, mouseData, flags) {
  inputBuf.fill(0);
  inputBuf.writeUInt32LE(INPUT_MOUSE, 0);
  inputBuf.writeInt32LE(dx, 8);
  inputBuf.writeInt32LE(dy, 12);
  inputBuf.writeInt32LE(mouseData, 16); // signed: wheel deltas can be negative
  inputBuf.writeUInt32LE(flags, 20);
  return SendInput(1, inputBuf, INPUT_SIZE);
}

function sendKey(vk, scan, flags) {
  inputBuf.fill(0);
  inputBuf.writeUInt32LE(INPUT_KEYBOARD, 0);
  inputBuf.writeUInt16LE(vk, 8);
  inputBuf.writeUInt16LE(scan, 10);
  inputBuf.writeUInt32LE(flags, 12);
  return SendInput(1, inputBuf, INPUT_SIZE);
}

function virtualScreen() {
  return {
    left: GetSystemMetrics(76), top: GetSystemMetrics(77),
    width: GetSystemMetrics(78), height: GetSystemMetrics(79),
  };
}

// Move to physical desktop pixel (x, y) across the whole virtual desktop.
function moveAbsolute(x, y, vs = virtualScreen()) {
  const ax = Math.min(65535, Math.max(0, Math.round(((x - vs.left) + 0.5) * 65536 / vs.width)));
  const ay = Math.min(65535, Math.max(0, Math.round(((y - vs.top) + 0.5) * 65536 / vs.height)));
  return sendMouse(ax, ay, 0, MOUSE.MOVE | MOUSE.ABSOLUTE | MOUSE.VIRTUALDESK);
}

function cursorPos() {
  const p = Buffer.alloc(8);
  GetCursorPos(p);
  return { x: p.readInt32LE(0), y: p.readInt32LE(4) };
}

// ---------------------------------------------------------------- clipboard
// Opened with a NULL owner: no hidden window means no unpumped message queue that
// other apps' clipboard calls could block on.

const OpenClipboard = user32.func('int __stdcall OpenClipboard(void *owner)');
const CloseClipboard = user32.func('int __stdcall CloseClipboard()');
const EmptyClipboard = user32.func('int __stdcall EmptyClipboard()');
const GetClipboardData = user32.func('void * __stdcall GetClipboardData(uint32_t format)');
const SetClipboardData = user32.func('void * __stdcall SetClipboardData(uint32_t format, void *mem)');
const IsClipboardFormatAvailable = user32.func('int __stdcall IsClipboardFormatAvailable(uint32_t format)');
const GetClipboardSequenceNumber = user32.func('uint32_t __stdcall GetClipboardSequenceNumber()');
const GlobalAlloc = kernel32.func('void * __stdcall GlobalAlloc(uint32_t flags, size_t bytes)');
const GlobalLock = kernel32.func('void * __stdcall GlobalLock(void *mem)');
const GlobalUnlock = kernel32.func('int __stdcall GlobalUnlock(void *mem)');
const GlobalSize = kernel32.func('size_t __stdcall GlobalSize(void *mem)');
const GlobalFree = kernel32.func('void * __stdcall GlobalFree(void *mem)');
const CF_UNICODETEXT = 13, GMEM_MOVEABLE = 0x0002;

function openClipboard() {
  for (let i = 0; i < 10; i++) if (OpenClipboard(null)) return true;
  return false;
}

// Returns the text, null when the clipboard holds no text, or undefined when
// another app has it open right now (worth retrying).
function readClipboardText() {
  if (!IsClipboardFormatAvailable(CF_UNICODETEXT)) return null;
  if (!openClipboard()) return undefined;
  try {
    const h = GetClipboardData(CF_UNICODETEXT);
    if (!h) return null;
    const p = GlobalLock(h);
    if (!p) return null;
    try {
      const size = Number(GlobalSize(h));
      const text = Buffer.from(new Uint8Array(koffi.view(p, size))).toString('utf16le');
      const nul = text.indexOf('\0');
      return nul >= 0 ? text.slice(0, nul) : text;
    } finally { GlobalUnlock(h); }
  } finally { CloseClipboard(); }
}

function writeClipboardText(text) {
  const data = Buffer.from(text + '\0', 'utf16le');
  const h = GlobalAlloc(GMEM_MOVEABLE, data.length);
  if (!h) return false;
  const p = GlobalLock(h);
  if (!p) { GlobalFree(h); return false; }
  new Uint8Array(koffi.view(p, data.length)).set(data);
  GlobalUnlock(h);
  if (!openClipboard()) { GlobalFree(h); return false; }
  try {
    EmptyClipboard();
    if (!SetClipboardData(CF_UNICODETEXT, h)) { GlobalFree(h); return false; }
    return true; // the system owns h now
  } finally { CloseClipboard(); }
}

// ---------------------------------------------------------------- power

const SetThreadExecutionState = kernel32.func('uint32_t __stdcall SetThreadExecutionState(uint32_t flags)');
const ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2;

function keepAwake(on) {
  SetThreadExecutionState(on ? (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) >>> 0 : ES_CONTINUOUS);
}

module.exports = {
  makeDpiAware, listOutputs, virtualScreen, moveAbsolute, cursorPos,
  sendMouse, sendKey, MOUSE, KEY,
  readClipboardText, writeClipboardText, clipboardSequence: () => GetClipboardSequenceNumber(),
  keepAwake,
};
