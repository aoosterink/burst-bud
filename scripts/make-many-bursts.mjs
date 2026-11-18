// Quick stress shoot: N small bursts (small images, fast to generate).
// Usage: node scripts/make-many-bursts.mjs <out> [bursts=100]   (SOURCE=photo.jpg to use your own picture)
import sharp from 'sharp';
import { mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sourceImage } from './source-image.mjs';

const OUT = resolve(process.argv[2] ?? 'many-bursts');
const N = Number(process.argv[3] ?? 100);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const pad = (n, l = 2) => String(n).padStart(l, '0');
const exifDate = (d) => `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const { input: SRC, width: SW, height: SH } = await sourceImage();

let t = new Date(2026, 10, 14, 9, 0, 0).getTime();
let n = 1;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let b = 0; b < N; b++) {
  const count = 1 + Math.floor(rnd() ** 2 * 30); // mostly short bursts, a few long ones
  const hue = Math.floor(rnd() * 360);
  for (let i = 0; i < count; i++) {
    const p = count > 1 ? i / (count - 1) : 0.5;
    const cw = Math.round(SW * 0.62), ch = Math.round(cw / 1.5);
    const time = new Date(t + i * 100);
    const name = `IMG_${pad(n++, 4)}.JPG`;
    await sharp(SRC)
      .extract({ left: Math.round((SW - cw) * p), top: Math.round((SH - ch) / 2), width: cw, height: ch })
      .resize(900, 600)
      .modulate({ hue })
      .withExif({ IFD2: { DateTimeOriginal: exifDate(time), SubSecTimeOriginal: pad(time.getMilliseconds(), 3) } })
      .jpeg({ quality: 70 })
      .toFile(join(OUT, name));
    utimesSync(join(OUT, name), time, time);
  }
  t += count * 100 + 5000 + Math.floor(rnd() * 60000);
}
console.log(`${n - 1} photos in ${N} bursts → ${OUT}`);
