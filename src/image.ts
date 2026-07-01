import { Buffer } from 'node:buffer';

function toStream(buffer: ArrayBuffer): ReadableStream<Uint8Array> {
  return new Response(buffer).body!;
}

function looksLikeJpeg(bytes: Uint8Array, start: number, end: number): boolean {
  if (end - start < 32) return false;

  // Accept only real JPEG marker streams. H.264 payloads can coincidentally
  // contain FF D8 FF ... FF D9 byte sequences.
  for (let i = start + 2; i < end - 1;) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    while (i < end && bytes[i] === 0xff) i++;
    if (i >= end) break;

    const marker = bytes[i++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > end) return false;

    const len = (bytes[i] << 8) | bytes[i + 1];
    if (len < 2 || i + len > end) return false;

    // Start Of Frame markers prove this is a decodable image, not just APP data.
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf
    ) {
      return true;
    }
    i += len;
  }
  return false;
}

// Scan for an embedded JPEG thumbnail. iPhone MP4s can store a cover image in
// metadata; re-encoded files typically don't.
export function extractJpegFromMp4(buffer: ArrayBuffer): ArrayBuffer | null {
  const bytes = new Uint8Array(buffer);
  const limit = Math.min(bytes.length, 8 * 1024 * 1024);
  for (let i = 0; i < limit - 3; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      for (let j = i + 4; j < bytes.length - 1; j++) {
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
          const end = j + 2;
          if (looksLikeJpeg(bytes, i, end)) return buffer.slice(i, end);
          break;
        }
      }
    }
  }
  return null;
}

const MAX_WIDTH = 1080;
const WATERMARK_WIDTH_RATIO = 0.28;
const WATERMARK_MARGIN_RATIO = 0.025;

/**
 * Resize and optionally composite a watermark via Cloudflare's Images
 * binding — see docs/adr/0003-image-processing-via-cloudflare-images-binding.md
 * for why this replaced an in-Worker codec.
 */
export async function processImage(
  images: ImagesBinding,
  buffer: ArrayBuffer,
  options?: { watermarkB64?: string },
): Promise<ArrayBuffer> {
  let transformer = images
    .input(toStream(buffer))
    .transform({ width: MAX_WIDTH, fit: 'scale-down' });

  if (options?.watermarkB64) {
    // Buffer.from() can return a view into a larger pooled ArrayBuffer, so
    // slice to the exact byte range before handing it to the binding.
    const wmBytes = Buffer.from(options.watermarkB64, 'base64');
    const wmBuffer = wmBytes.buffer.slice(
      wmBytes.byteOffset,
      wmBytes.byteOffset + wmBytes.byteLength,
    ) as ArrayBuffer;

    const wmWidth = Math.round(MAX_WIDTH * WATERMARK_WIDTH_RATIO);
    const margin = Math.round(MAX_WIDTH * WATERMARK_MARGIN_RATIO);
    transformer = transformer.draw(
      images.input(toStream(wmBuffer)).transform({ width: wmWidth }),
      { bottom: margin, right: margin },
    );
  }

  const result = await transformer.output({
    format: 'image/jpeg',
    quality: 88,
  });
  return result.response().arrayBuffer();
}
