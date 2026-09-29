import type { MediaDescriptor, MediaKind } from '@/db/db';

/** 100 MB of content (FR-5.2, 5.3). */
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;
const THUMB_EDGE = 64;

export interface PreparedMedia {
  blob: Blob;
  descriptor: MediaDescriptor;
}

export class MediaTooLargeError extends Error {}

export function kindOf(mime: string): MediaKind {
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Turns a picked file into what we actually send: images are downscaled and recompressed
 * (FR-5.1), images and videos get a tiny inline thumbnail and their dimensions, audio and video
 * their duration.
 *
 * <p>Thumbnails are made here, not by a server worker as the pre-E2EE design had it: the server
 * only ever sees ciphertext, so it has nothing to thumbnail.
 */
export async function prepareMedia(file: File): Promise<PreparedMedia> {
  const mime = file.type || 'application/octet-stream';
  const kind = kindOf(mime);
  let blob: Blob = file;
  const descriptor: MediaDescriptor = { kind, mime, name: file.name, size: file.size };

  try {
    if (kind === 'image') {
      const bitmap = await createImageBitmap(file);
      descriptor.width = bitmap.width;
      descriptor.height = bitmap.height;
      descriptor.thumbnail = drawThumbnail(bitmap, bitmap.width, bitmap.height);
      // GIFs keep their animation; everything else is fair game for recompression.
      if (mime !== 'image/gif') {
        const recompressed = await recompress(bitmap);
        if (recompressed && recompressed.size < file.size) {
          blob = recompressed;
          descriptor.mime = 'image/jpeg';
          descriptor.width = Math.round(bitmap.width * scaleFor(bitmap.width, bitmap.height));
          descriptor.height = Math.round(bitmap.height * scaleFor(bitmap.width, bitmap.height));
          descriptor.name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
        }
      }
      bitmap.close();
    } else if (kind === 'video') {
      Object.assign(descriptor, await probeVideo(file));
    } else if (kind === 'audio') {
      descriptor.durationMs = await probeDuration(file, 'audio');
    }
  } catch (error) {
    // A file the browser cannot decode still sends; it just goes without a preview.
    console.warn('[media] could not process attachment; sending as-is', error);
  }

  descriptor.size = blob.size;
  if (blob.size > MAX_MEDIA_BYTES) {
    throw new MediaTooLargeError(`${file.name} is larger than 100 MB`);
  }
  return { blob, descriptor };
}

function scaleFor(width: number, height: number): number {
  return Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
}

async function recompress(bitmap: ImageBitmap): Promise<Blob | null> {
  const scale = scaleFor(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;
  // JPEG has no alpha; paint white under transparent PNGs rather than letting them go black.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

function drawThumbnail(source: CanvasImageSource, width: number, height: number): string | undefined {
  const scale = THUMB_EDGE / Math.max(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6);
}

function probeDuration(file: File, tag: 'audio' | 'video'): Promise<number | undefined> {
  return new Promise((resolve) => {
    const element = document.createElement(tag);
    const url = URL.createObjectURL(file);
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : undefined);
    };
    element.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(undefined);
    };
    element.src = url;
  });
}

/** Duration, dimensions and a poster frame (FR-5.2) from a frame just past the start. */
function probeVideo(file: File): Promise<Partial<MediaDescriptor>> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (result: Partial<MediaDescriptor>) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(0.1, video.duration / 2 || 0);
    };
    video.onseeked = () =>
      done({
        width: video.videoWidth,
        height: video.videoHeight,
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
        thumbnail: drawThumbnail(video, video.videoWidth, video.videoHeight),
      });
    video.onerror = () => done({});
    video.src = url;
  });
}
