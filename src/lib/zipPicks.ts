import { makeZip, predictLength } from 'client-zip';
import type { SavePlanEntry } from './savePicks';

/**
 * Safari / Firefox can't write into a folder, so picks are downloaded as a ZIP instead.
 * Files are stored, not re-compressed (photos don't shrink, and the copies stay
 * byte-identical). Everything sits in one top folder so unzipping recreates "<shoot> picks".
 * Very large selections are split into parts, since the browser holds each ZIP in memory
 * before handing it to the download.
 */

export const MAX_PART_BYTES = 1.8e9;

export function splitParts(plan: SavePlanEntry[], maxBytes = MAX_PART_BYTES): SavePlanEntry[][] {
  const parts: SavePlanEntry[][] = [];
  let cur: SavePlanEntry[] = [];
  let size = 0;
  for (const e of plan) {
    if (cur.length && size + e.file.size > maxBytes) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += e.file.size;
  }
  if (cur.length) parts.push(cur);
  return parts;
}

const entries = (part: SavePlanEntry[], folder: string) =>
  part.map((e) => ({ input: e.file, name: folder ? `${folder}/${e.name}` : e.name, lastModified: new Date(e.file.lastModified) }));

export function zipSize(part: SavePlanEntry[], folder: string): number {
  return Number(predictLength(entries(part, folder).map(({ name, input }) => ({ name, size: input.size }))));
}

/** Build one ZIP as a Blob, reporting bytes written. */
export async function buildZip(part: SavePlanEntry[], folder: string, onProgress: (done: number, total: number) => void): Promise<Blob> {
  const total = zipSize(part, folder);
  let done = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      done += chunk.byteLength;
      onProgress(done, total);
      ctrl.enqueue(chunk);
    },
  });
  const blob = await new Response(makeZip(entries(part, folder)).pipeThrough(counter)).blob();
  return new Blob([blob], { type: 'application/zip' });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start reading the blob before releasing it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
