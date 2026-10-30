'use strict';
// Runs ffmpeg (Desktop Duplication capture -> NVENC H.264) and parses its FLV
// output so every access unit is emitted the moment ffmpeg writes it.

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// Constant-quality targets; the bitrate cap still bounds each frame's size.
const QUALITY_CQ = { ultra: 15, high: 19, balanced: 24 };

class FlvParser {
  constructor(onVideoTag) {
    this.onVideoTag = onVideoTag;
    this.buf = Buffer.alloc(0);
    this.headerDone = false;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let pos = 0;
    if (!this.headerDone) {
      if (this.buf.length < 13) return;
      if (this.buf.toString('latin1', 0, 3) !== 'FLV') throw new Error('not an FLV stream');
      pos = this.buf.readUInt32BE(5) + 4; // header + PreviousTagSize0
      this.headerDone = true;
    }
    // Tag: type(1) size(3) timestamp(3) tsExt(1) streamId(3) data(size) prevTagSize(4)
    while (this.buf.length - pos >= 11) {
      const size = this.buf.readUIntBE(pos + 1, 3);
      if (this.buf.length - pos < 11 + size + 4) break;
      if (this.buf[pos] === 9) {
        const ts = (this.buf[pos + 7] << 24 | this.buf.readUIntBE(pos + 4, 3)) >>> 0;
        this.onVideoTag(this.buf.subarray(pos + 11, pos + 11 + size), ts);
      }
      pos += 11 + size + 4;
    }
    this.buf = this.buf.subarray(pos);
  }
}

class Encoder extends EventEmitter {
  constructor(ffmpegPath) {
    super();
    this.ffmpegPath = ffmpegPath;
    this.proc = null;
  }

  static args({ outputIndex, fps, maxBitrate, quality, drawMouse }) {
    const cq = QUALITY_CQ[quality] ?? QUALITY_CQ.high;
    const maxBits = maxBitrate * 1e6;
    // VBV of ~4 average frames: big enough for crisp scene changes, small enough
    // that no single frame takes long on the wire.
    const bufsize = Math.round((maxBits / fps) * 4);
    return [
      '-hide_banner', '-nostats', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `ddagrab=output_idx=${outputIndex}:framerate=${fps}:draw_mouse=${drawMouse ? 1 : 0}`,
      '-c:v', 'h264_nvenc', '-profile:v', 'high',
      '-preset', 'p4', '-tune', 'ull', '-zerolatency', '1', '-delay', '0', '-bf', '0',
      '-rc', 'vbr', '-cq', String(cq), '-b:v', '0', '-maxrate', String(maxBits), '-bufsize', String(bufsize),
      // Effectively infinite GOP: a fresh IDR comes from restarting the encoder on demand.
      '-g', '100000', '-no-scenecut', '1', '-forced-idr', '1',
      '-fps_mode', 'passthrough',
      '-flush_packets', '1', '-f', 'flv', '-flvflags', 'no_duration_filesize', 'pipe:1',
    ];
  }

  start(opts) {
    this.stop();
    const proc = spawn(this.ffmpegPath, Encoder.args(opts), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let stderr = '';

    const parser = new FlvParser((tag, ts) => {
      if (this.proc !== proc) return;
      const b0 = tag[0];
      if ((b0 & 0x0f) !== 7) return; // legacy FLV AVC only (what ffmpeg writes for H.264)
      const key = (b0 >> 4) === 1;
      if (tag[1] === 0) {
        const avcC = tag.subarray(5);
        const codec = 'avc1.' + [avcC[1], avcC[2], avcC[3]].map((v) => v.toString(16).padStart(2, '0')).join('');
        this.emit('config', { codec, description: Buffer.from(avcC) });
      } else if (tag[1] === 1) {
        this.emit('frame', { key, data: tag.subarray(5), ts });
      }
    });

    proc.stdout.on('data', (chunk) => {
      try { parser.push(chunk); } catch (e) { stderr += String(e); this.stop(); }
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.on('error', (e) => { stderr += String(e); });
    proc.on('close', (code) => {
      if (this.proc !== proc) return; // stopped on purpose
      this.proc = null;
      this.emit('exit', { code, stderr: stderr.trim() });
    });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc && proc.exitCode === null) proc.kill();
  }
}

module.exports = { Encoder, QUALITY_CQ };
