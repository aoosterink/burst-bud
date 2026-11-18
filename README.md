# Burst Bud

Action photo review: sort through burst shots and keep the one.

Find the keepers in a shoot full of bursts. Runs entirely in the browser; files are never uploaded and originals are never changed.

## Run

```bash
npm install
npm run dev
```

Test data:

- `node scripts/make-test-folder.mjs <folder>`: a test shoot with tricky cases (close gaps, two camera bodies, RAW twins, no-EXIF photos, videos; needs `ffmpeg`).
- `node scripts/make-many-bursts.mjs <folder> 100`: a large shoot (~1,000 photos in 100 bursts) for performance checks.
- `node scripts/make-intro-surf.mjs <photo>`: rebuilds the intro background `public/assets/intro-surf.webp` with the keeper frame.

## How it works

- **Import**: pick a folder (Chrome/Edge/Arc use the File System Access picker; other browsers fall back to a folder upload input). Subfolders are walked recursively. JPG/PNG/WebP/AVIF/HEIC, RAW (a RAW with a same-named JPG is attached to it rather than shown twice) and videos.
- **Bursts**: photos are sorted by EXIF `DateTimeOriginal` + `SubSecTimeOriginal` (file date when missing). A new burst starts when the gap to the previous photo is greater than the burst gap, or when the folder changes. Videos are never grouped.
- **Review**: press and hold the photo and slide toward either edge to seek through the burst; release to stop. Also: drag the bar under the strip, scroll/trackpad, ← →.
- **Labels**: Keep (K), archive the unkept rest of a burst (A), or archive every unkept photo in the shoot. Every action is undoable (⌘Z or the toast). Labels are saved in localStorage per folder.

## Code map

- `src/lib/scan.ts`: folder walking, RAW pairing, EXIF capture times
- `src/lib/group.ts`: burst grouping (tested in `src/lib/__tests__`)
- `src/lib/images.ts`: thumbnail and preview decoding with LIFO queues and an LRU of decoded previews
- `src/lib/store.ts`: review state, filters, undo, persistence
- `src/components/Stage.tsx`: the focus wave, hold-and-slide seeking, scrub strip
