#!/usr/bin/env node
// Generate the Reqit marketplace icon (128x128 and 256x256 PNG) without
// any external image dependencies. We hand-roll a tiny PNG encoder.
//
// Design:
//   - Dark navy rounded-square background (matches galleryBanner color #0B1220)
//   - Cyan "{}" braces evoking a JSON payload / .http file
//   - Orange "→" arrow through the middle = a request being sent
//
// Run: `node scripts/generate-icon.mjs` (outputs media/icon.png + icon@2x.png)

import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'media');
mkdirSync(outDir, { recursive: true });

// ---- Color palette (sRGB) ----
const BG = [0x0b, 0x12, 0x20, 0xff]; // navy
const FG = [0x4f, 0xd1, 0xe5, 0xff]; // cyan braces
const ACCENT = [0xf9, 0x73, 0x16, 0xff]; // orange arrow
const SHADOW = [0x00, 0x00, 0x00, 0x55];

function makeCanvas(size) {
  const pixels = new Uint8Array(size * size * 4);
  return { size, pixels };
}

function setPx(c, x, y, rgba) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return;
  const i = (y * c.size + x) * 4;
  // Alpha blend over existing pixel
  const [r, g, b, a] = rgba;
  const sa = a / 255;
  const da = c.pixels[i + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA === 0) return;
  c.pixels[i] = Math.round((r * sa + c.pixels[i] * da * (1 - sa)) / outA);
  c.pixels[i + 1] = Math.round((g * sa + c.pixels[i + 1] * da * (1 - sa)) / outA);
  c.pixels[i + 2] = Math.round((b * sa + c.pixels[i + 2] * da * (1 - sa)) / outA);
  c.pixels[i + 3] = Math.round(outA * 255);
}

function fillRoundedRect(c, x0, y0, w, h, radius, rgba) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      // Distance from nearest corner center
      let dx = 0;
      let dy = 0;
      if (x < x0 + radius) dx = x0 + radius - x;
      else if (x >= x0 + w - radius) dx = x - (x0 + w - radius - 1);
      if (y < y0 + radius) dy = y0 + radius - y;
      else if (y >= y0 + h - radius) dy = y - (y0 + h - radius - 1);
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= radius - 0.5) {
        setPx(c, x, y, rgba);
      } else if (d < radius + 0.5) {
        const alpha = Math.max(0, Math.min(1, radius + 0.5 - d));
        setPx(c, x, y, [rgba[0], rgba[1], rgba[2], Math.round(rgba[3] * alpha)]);
      }
    }
  }
}

function strokeLine(c, x1, y1, x2, y2, thickness, rgba) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len === 0) return;
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x1 + dx * t;
    const cy = y1 + dy * t;
    fillCircle(c, cx, cy, thickness / 2, rgba);
  }
}

function fillCircle(c, cx, cy, r, rgba) {
  const x0 = Math.floor(cx - r - 1);
  const x1 = Math.ceil(cx + r + 1);
  const y0 = Math.floor(cy - r - 1);
  const y1 = Math.ceil(cy + r + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r - 0.5) setPx(c, x, y, rgba);
      else if (d < r + 0.5) {
        const a = Math.max(0, Math.min(1, r + 0.5 - d));
        setPx(c, x, y, [rgba[0], rgba[1], rgba[2], Math.round(rgba[3] * a)]);
      }
    }
  }
}

function fillTriangle(c, p1, p2, p3, rgba) {
  const xs = [p1[0], p2[0], p3[0]];
  const ys = [p1[1], p2[1], p3[1]];
  const minX = Math.floor(Math.min(...xs));
  const maxX = Math.ceil(Math.max(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxY = Math.ceil(Math.max(...ys));
  const sign = (a, b, c2) =>
    (a[0] - c2[0]) * (b[1] - c2[1]) - (b[0] - c2[0]) * (a[1] - c2[1]);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x + 0.5, y + 0.5];
      const d1 = sign(p, p1, p2);
      const d2 = sign(p, p2, p3);
      const d3 = sign(p, p3, p1);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) setPx(c, x, y, rgba);
    }
  }
}

// Draw a "{" or "}" brace as a stroked path.
function drawBrace(c, side, cx, cy, height, thickness, rgba) {
  const half = height / 2;
  const bulge = thickness * 1.4 * (side === 'left' ? -1 : 1);
  // Top half: vertical down, then curve toward center notch
  const top = [cx, cy - half];
  const topMid = [cx, cy - half * 0.45];
  const notch = [cx + bulge, cy];
  const botMid = [cx, cy + half * 0.45];
  const bot = [cx, cy + half];
  strokeLine(c, top[0], top[1], topMid[0], topMid[1], thickness, rgba);
  strokeLine(c, topMid[0], topMid[1], notch[0], notch[1], thickness, rgba);
  strokeLine(c, notch[0], notch[1], botMid[0], botMid[1], thickness, rgba);
  strokeLine(c, botMid[0], botMid[1], bot[0], bot[1], thickness, rgba);
  // Soften endpoints
  fillCircle(c, top[0], top[1], thickness / 2, rgba);
  fillCircle(c, bot[0], bot[1], thickness / 2, rgba);
  fillCircle(c, notch[0], notch[1], thickness / 2, rgba);
}

function drawArrow(c, x1, y1, x2, y2, thickness, headSize, rgba) {
  strokeLine(c, x1, y1, x2 - headSize * 0.5, y2, thickness, rgba);
  const head1 = [x2, y2];
  const head2 = [x2 - headSize, y2 - headSize * 0.6];
  const head3 = [x2 - headSize, y2 + headSize * 0.6];
  fillTriangle(c, head1, head2, head3, rgba);
}

function render(size) {
  const c = makeCanvas(size);
  const s = size;
  // Background rounded square
  fillRoundedRect(c, 0, 0, s, s, s * 0.18, BG);

  // Subtle inner shadow on background bottom for depth
  fillRoundedRect(c, 0, Math.round(s * 0.78), s, Math.round(s * 0.22), s * 0.18, SHADOW);
  // Re-paint top portion so shadow stays only on bottom band area
  fillRoundedRect(c, 0, 0, s, Math.round(s * 0.78), s * 0.18, BG);

  const cy = s * 0.5;
  const braceHeight = s * 0.62;
  const braceThickness = Math.max(2, s * 0.055);
  const leftX = s * 0.22;
  const rightX = s * 0.78;

  drawBrace(c, 'left', leftX, cy, braceHeight, braceThickness, FG);
  drawBrace(c, 'right', rightX, cy, braceHeight, braceThickness, FG);

  // Arrow across the middle
  const arrowY = cy;
  const arrowX1 = s * 0.33;
  const arrowX2 = s * 0.7;
  const arrowThickness = Math.max(2, s * 0.07);
  const arrowHead = s * 0.13;
  drawArrow(c, arrowX1, arrowY, arrowX2, arrowY, arrowThickness, arrowHead, ACCENT);

  return c;
}

// ---- PNG encoder ----
function u32be(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function chunk(type, data) {
  const len = u32be(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = u32be(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng({ size, pixels }) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.concat([
    u32be(size),
    u32be(size),
    Buffer.from([8, 6, 0, 0, 0]), // 8-bit, RGBA
  ]);
  // Filter byte 0 per scanline, then raw RGBA.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function writePng(canvas, file) {
  const buf = encodePng(canvas);
  await new Promise((resolveP, reject) => {
    const stream = createWriteStream(file);
    stream.on('error', reject);
    stream.on('finish', resolveP);
    stream.end(buf);
  });
  // eslint-disable-next-line no-console
  console.log(`wrote ${file} (${buf.length} bytes)`);
}

await writePng(render(128), resolve(outDir, 'icon.png'));
await writePng(render(256), resolve(outDir, 'icon@2x.png'));
