/**
 * 生成托盘图标（不引入任何图形依赖）：用 zlib 手写最小 PNG。
 *
 * 图案：圆角方块（accent 渐变蓝紫）+ 中间一条白色上箭头（呼应「上行代理」）。
 * 输出 256×256（给 electron-builder 生成 .ico）与 32×32（给托盘用）。
 *
 * 用法：node scripts/make-tray-icon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 圆角方块 + 上箭头。坐标都用 0..1 的相对值，便于任意尺寸渲染。 */
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = 0.22;
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const index = (y * size + x) * 4;
    const alpha = a / 255;
    rgba[index] = Math.round(rgba[index] * (1 - alpha) + r * alpha);
    rgba[index + 1] = Math.round(rgba[index + 1] * (1 - alpha) + g * alpha);
    rgba[index + 2] = Math.round(rgba[index + 2] * (1 - alpha) + b * alpha);
    rgba[index + 3] = Math.max(rgba[index + 3], Math.round(255 * alpha));
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      // 圆角矩形（用四角圆心的距离判定）
      const cx = Math.min(Math.max(nx, radius), 1 - radius);
      const cy = Math.min(Math.max(ny, radius), 1 - radius);
      const distance = Math.hypot(nx - cx, ny - cy);
      if (distance > radius) continue;
      const edge = Math.min(1, (radius - distance) * size / 1.5);
      // 对角渐变：#6f8cff → #9a6bff
      const t = (nx + ny) / 2;
      const r = Math.round(0x6f + (0x9a - 0x6f) * t);
      const g = Math.round(0x8c + (0x6b - 0x8c) * t);
      const b = Math.round(0xff + (0xff - 0xff) * t);
      put(x, y, r, g, b, 255 * Math.min(1, Math.max(0, edge)));
    }
  }

  // 上箭头：竖杆 + 三角头（白色）
  const barHalf = 0.055;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      let hit = false;
      if (Math.abs(nx - 0.5) <= barHalf && ny >= 0.42 && ny <= 0.78) hit = true;
      if (ny >= 0.22 && ny <= 0.46) {
        const spread = (ny - 0.22) * 1.15;
        if (Math.abs(nx - 0.5) <= spread) hit = true;
      }
      if (hit) put(x, y, 255, 255, 255, 255 * 0.95);
    }
  }
  return rgba;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [256, 32]) {
  const file = path.join(OUT_DIR, size === 256 ? 'icon.png' : 'tray-icon.png');
  fs.writeFileSync(file, encodePNG(size, size, render(size)));
  console.log(`已生成 ${file}（${size}×${size}）`);
}
