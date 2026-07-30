/* make-icon.mjs — draws income-tracker.ico from the same mark as the favicon
   in src/shell.html: a rounded blue tile with three ascending bars.
   Run: node make-icon.mjs

   The .ico is committed, so this only needs running if the mark changes.
   Nothing is imported: the shape is rasterised from its own geometry and
   wrapped in an ICO container by hand, the same way src/xlsx.js writes a ZIP.

   Every size is stored as a 32-bit BMP rather than a PNG. PNG entries would be
   smaller, but they need a real DEFLATE implementation to beat raw bytes, and
   BMP is what every Windows icon reader has always understood. */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* Sizes Windows actually asks for: list view, details, tiles, large icons.
   256 is left out — it would triple the file for a flat geometric mark that
   upscales from 128 without visible loss. */
const SIZES = [16, 24, 32, 48, 64, 128];
const SUPERSAMPLE = 4; // 4x4 samples per pixel, so the curves are not jagged

const BLUE = [0x25, 0x63, 0xeb];
const WHITE = [0xff, 0xff, 0xff];

/* Geometry in the favicon's own 100x100 viewBox. */
const CORNER = 22;
const STROKE = 11;
const BARS = [
  { x: 28, top: 44, bottom: 68 },
  { x: 50, top: 30, bottom: 68 },
  { x: 72, top: 54, bottom: 68 }
];

/* Signed distance to the rounded square: negative inside, positive outside. */
function distanceToTile(px, py) {
  const dx = Math.abs(px - 50) - (50 - CORNER);
  const dy = Math.abs(py - 50) - (50 - CORNER);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - CORNER;
}

/* Signed distance to a vertical round-capped bar. The bars are vertical, so
   the nearest point on the segment is just the clamped y. */
function distanceToBar(px, py, bar) {
  const nearestY = Math.min(Math.max(py, bar.top), bar.bottom);
  return Math.hypot(px - bar.x, py - nearestY) - STROKE / 2;
}

/* Straight-alpha RGBA, top row first. */
function rasterise(size) {
  const pixels = new Uint8Array(size * size * 4);
  const step = 100 / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let red = 0, green = 0, blue = 0, alpha = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          // Sample at subpixel centres, mapped into the 100x100 viewBox.
          const px = (x + (sx + 0.5) / SUPERSAMPLE) * step;
          const py = (y + (sy + 0.5) / SUPERSAMPLE) * step;

          if (distanceToTile(px, py) > 0) continue; // transparent surround
          const onBar = BARS.some((bar) => distanceToBar(px, py, bar) <= 0);
          const colour = onBar ? WHITE : BLUE;

          red += colour[0];
          green += colour[1];
          blue += colour[2];
          alpha += 1;
        }
      }

      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const i = (y * size + x) * 4;
      if (alpha > 0) {
        // Average colour over covering samples only, so edges do not darken
        // towards the transparent background.
        pixels[i] = Math.round(red / alpha);
        pixels[i + 1] = Math.round(green / alpha);
        pixels[i + 2] = Math.round(blue / alpha);
        pixels[i + 3] = Math.round((alpha / samples) * 255);
      }
    }
  }
  return pixels;
}

/* One icon image: BITMAPINFOHEADER, then bottom-up BGRA, then the 1-bit mask.
   biHeight is doubled because the header describes both. */
function encodeBMP(size, pixels) {
  const maskStride = Math.ceil(size / 8 / 4) * 4; // mask rows pad to 4 bytes
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4 + maskStride * size, 20);

  const colour = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskStride * size);

  for (let y = 0; y < size; y++) {
    const sourceRow = size - 1 - y; // BMP rows run bottom-up
    for (let x = 0; x < size; x++) {
      const from = (sourceRow * size + x) * 4;
      const to = (y * size + x) * 4;
      colour[to] = pixels[from + 2];     // B
      colour[to + 1] = pixels[from + 1]; // G
      colour[to + 2] = pixels[from];     // R
      colour[to + 3] = pixels[from + 3]; // A
      // The alpha channel carries transparency on anything modern, but the
      // 1-bit mask is still what very old readers consult.
      if (pixels[from + 3] < 128) mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, colour, mask]);
}

const images = SIZES.map((size) => ({ size, data: encodeBMP(size, rasterise(size)) }));

const directory = Buffer.alloc(6 + images.length * 16);
directory.writeUInt16LE(0, 0);              // reserved
directory.writeUInt16LE(1, 2);              // 1 = icon
directory.writeUInt16LE(images.length, 4);

let offset = directory.length;
images.forEach((image, i) => {
  const at = 6 + i * 16;
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, at);     // 0 means 256
  directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
  directory.writeUInt8(0, at + 2);          // no colour palette
  directory.writeUInt8(0, at + 3);          // reserved
  directory.writeUInt16LE(1, at + 4);       // planes
  directory.writeUInt16LE(32, at + 6);      // bits per pixel
  directory.writeUInt32LE(image.data.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += image.data.length;
});

const out = join(dirname(fileURLToPath(import.meta.url)), 'income-tracker.ico');
writeFileSync(out, Buffer.concat([directory, ...images.map((i) => i.data)]));
console.log(`built ${out} (${(offset / 1024).toFixed(1)} KB, ${SIZES.join('/')} px)`);
