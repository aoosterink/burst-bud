// Draws the app's keeper frame + "✓ Keep" badge around one surfer and exports a WebP for the intro page,
// plus a clean small copy used by the shortcut demos.
// Usage: node scripts/make-intro-surf.mjs <source image> [out=public/assets/intro-surf.webp]
import sharp from 'sharp';

const SRC = process.argv[2];
const OUT = process.argv[3] ?? 'public/assets/intro-surf.webp';
if (!SRC) throw new Error('Pass the source image path');

// Output is 2000px wide (enough for a full-screen background); the frame is in those pixels.
const W = 2000;
const resized = await sharp(SRC).rotate().resize({ width: W }).toBuffer();
const { height: H } = await sharp(resized).metadata();

// Frame around the keeper (second surfer from the left), in pixels of the 2000px-wide output.
// For another photo, pass BOX="x,y,w,h".
const [bx, by, bw, bh] = (process.env.BOX ?? '384,500,272,368').split(',').map(Number);
const box = { x: bx, y: by, w: bw, h: bh };
const ACCENT = '#f7c948';
const INK = '#1f1702';
const s = 1.4; // the image shows at ~1440px wide, so scale strokes up a bit
const r = 4 * s;

const badge = { x: box.x + 12 * s, y: box.y + 12 * s, h: 26 * s, w: 74 * s };

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <!-- soft glow ring (the app's kept box-shadow: 0 0 0 6px accent / 12%) -->
  <rect x="${box.x - 6 * s}" y="${box.y - 6 * s}" width="${box.w + 12 * s}" height="${box.h + 12 * s}" rx="${r + 6 * s}"
        fill="none" stroke="${ACCENT}" stroke-opacity="0.14" stroke-width="${12 * s}"/>
  <!-- the 3px accent outline -->
  <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${r}"
        fill="none" stroke="${ACCENT}" stroke-width="${3 * s}"/>
  <!-- "✓ Kept" badge -->
  <rect x="${badge.x}" y="${badge.y}" width="${badge.w}" height="${badge.h}" rx="${5 * s}" fill="${ACCENT}"/>
  <path d="M ${badge.x + 10 * s} ${badge.y + 13.5 * s} l ${3.4 * s} ${3.4 * s} l ${6.6 * s} ${-7.2 * s}"
        fill="none" stroke="${INK}" stroke-width="${2 * s}" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="${badge.x + 26 * s}" y="${badge.y + 17.6 * s}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
        font-weight="600" font-size="${12.5 * s}" fill="${INK}">Keep</text>
</svg>`;

await sharp(resized)
  .composite([{ input: Buffer.from(svg) }])
  .webp({ quality: 86, effort: 6 })
  .toFile(OUT);

const out = await sharp(OUT).metadata();
console.log(`${OUT} ${out.width}×${out.height}`);

// Clean, small copy (no frame) for the shortcut demos: they pan across it and tint it per burst.
const DEMO = 'public/assets/demo-surf.webp';
await sharp(resized).resize({ width: 960 }).webp({ quality: 78, effort: 6 }).toFile(DEMO);
const d = await sharp(DEMO).metadata();
console.log(`${DEMO} ${d.width}×${d.height}`);
