// Source picture for the test-data generators. Frames are crops that pan across it, so
// scrubbing a generated burst looks like motion.
// Use your own photo with SOURCE=path/to/photo.jpg; otherwise a drawn surf scene is used,
// so the repo doesn't need to ship any photo.
import sharp from 'sharp';

const W = 1376;
const H = 768;

function scene() {
  // Sky, sea, a breaking wave and a surfer silhouette on a board.
  return Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4d6680"/><stop offset="1" stop-color="#9fb3c4"/>
    </linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1d4766"/><stop offset="1" stop-color="#0c2236"/>
    </linearGradient>
    <linearGradient id="wave" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2f7c86"/><stop offset="1" stop-color="#1b5a6e"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  <g fill="#c8d4de" opacity="0.5">
    <ellipse cx="260" cy="120" rx="140" ry="22"/><ellipse cx="900" cy="90" rx="190" ry="26"/><ellipse cx="1180" cy="170" rx="120" ry="18"/>
  </g>
  <rect y="300" width="${W}" height="${H - 300}" fill="url(#sea)"/>
  <path d="M0 520 C 260 360, 520 330, 760 420 S 1180 560, ${W} 470 L ${W} ${H} L 0 ${H} Z" fill="url(#wave)"/>
  <path d="M520 400 C 600 300, 700 300, 760 420 C 700 380, 620 380, 560 430 Z" fill="#e8f1f5" opacity="0.85"/>
  <g transform="translate(720 360) rotate(-14)" fill="#10161d">
    <ellipse cx="0" cy="118" rx="96" ry="12" fill="#eef2f4"/>
    <circle cx="6" cy="-58" r="17"/>
    <path d="M-8 -40 L 24 -40 L 30 20 L 8 22 Z"/>
    <path d="M-6 -34 L -70 -14 L -66 -6 L -2 -20 Z"/>
    <path d="M24 -34 L 70 2 L 64 8 L 20 -18 Z"/>
    <path d="M8 18 L -30 70 L -24 112 L -12 112 L -14 76 L 18 34 Z"/>
    <path d="M24 18 L 44 70 L 34 112 L 46 112 L 58 70 L 32 16 Z"/>
  </g>
</svg>`);
}

/** Returns { input, width, height } to feed into sharp(). */
export async function sourceImage() {
  if (process.env.SOURCE) {
    const meta = await sharp(process.env.SOURCE).metadata();
    return { input: process.env.SOURCE, width: meta.width, height: meta.height };
  }
  const input = await sharp(scene()).jpeg({ quality: 92 }).toBuffer();
  return { input, width: W, height: H };
}
