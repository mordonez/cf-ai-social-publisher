import { describe, expect, it } from 'vitest';
import { extractJpegFromMp4 } from './image';

// Minimal but structurally valid JPEG: SOI, a COM segment (padding so the
// marker stream is long enough for looksLikeJpeg's 32-byte minimum), a real
// SOF0 marker (proves it's a decodable image, not just APP data), then EOI.
const SYNTHETIC_JPEG = new Uint8Array([
  0xFF, 0xD8, // SOI
  0xFF, 0xFE, 0x00, 0x11, ...Array(15).fill(0x41), // COM, length 17 (padding)
  0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x11, 0x00, // SOF0, length 11
  0xFF, 0xD9, // EOI
]);

describe('extractJpegFromMp4', () => {
  it('finds embedded JPEGs after the old 512KB scan window', () => {
    const padding = new Uint8Array(700 * 1024);
    const mp4Like = new Uint8Array(padding.byteLength + SYNTHETIC_JPEG.byteLength);
    mp4Like.set(padding);
    mp4Like.set(SYNTHETIC_JPEG, padding.byteLength);

    const thumbnail = extractJpegFromMp4(mp4Like.buffer);

    expect(thumbnail?.byteLength).toBe(SYNTHETIC_JPEG.byteLength);
  });

  it('ignores H.264 byte sequences that only look like JPEG boundaries', () => {
    const fake = new Uint8Array([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0xFF, 0xD8, 0xFF, 0x6F,
      0xDE, 0xFD, 0xE9, 0x95,
      0x1A, 0x96, 0x2A, 0x46,
      0xFF, 0xD9,
    ]);

    expect(extractJpegFromMp4(fake.buffer)).toBeNull();
  });
});
