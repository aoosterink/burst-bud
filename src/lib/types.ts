export type Status = 'review' | 'keep' | 'archived';

export type MediaKind = 'photo' | 'video';

export interface MediaItem {
  /** Stable id: path relative to the imported root folder. */
  id: string;
  kind: MediaKind;
  name: string;
  /** Folder path relative to the root ('' for the root itself). */
  folder: string;
  file: File;
  /** RAW file that shares this photo's base name, if any. */
  raw?: File;
  /** Capture time in ms since epoch (EXIF incl. sub-seconds when available). */
  time: number;
  /** True when time came from EXIF, false when it fell back to file modified time. */
  exifTime: boolean;
}

/** A run of photos shot close together, or a single video. */
export interface Group {
  id: string;
  kind: MediaKind;
  /** Item ids in capture order. */
  items: string[];
  start: number;
  end: number;
}

/** active = everything not archived; kept = only kept photos. */
export type Filter = 'active' | 'kept';
