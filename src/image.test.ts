import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { extractJpegFromMp4, processImage } from './image';

type Call = [method: string, opts: unknown];

function createFakeImagesBinding() {
  const calls: Call[] = [];
  const chain = {
    transform(opts: unknown) {
      calls.push(['transform', opts]);
      return chain;
    },
    draw(_image: unknown, opts: unknown) {
      calls.push(['draw', opts]);
      return chain;
    },
    async output(opts: unknown) {
      calls.push(['output', opts]);
      const bytes = new Uint8Array([1, 2, 3]).buffer;
      return { response: () => new Response(bytes) };
    },
  };
  const images = {
    calls,
    input: () => chain,
  };
  return images as unknown as ImagesBinding & { calls: Call[] };
}

// Minimal but structurally valid JPEG: SOI, a COM segment (padding so the
// marker stream is long enough for looksLikeJpeg's 32-byte minimum), a real
// SOF0 marker (proves it's a decodable image, not just APP data), then EOI.
const SYNTHETIC_JPEG = new Uint8Array([
  0xff,
  0xd8, // SOI
  0xff,
  0xfe,
  0x00,
  0x11,
  ...Array(15).fill(0x41), // COM, length 17 (padding)
  0xff,
  0xc0,
  0x00,
  0x0b,
  0x08,
  0x00,
  0x01,
  0x00,
  0x01,
  0x01,
  0x11,
  0x00, // SOF0, length 11
  0xff,
  0xd9, // EOI
]);

describe('extractJpegFromMp4', () => {
  it('finds embedded JPEGs after the old 512KB scan window', () => {
    const padding = new Uint8Array(700 * 1024);
    const mp4Like = new Uint8Array(
      padding.byteLength + SYNTHETIC_JPEG.byteLength,
    );
    mp4Like.set(padding);
    mp4Like.set(SYNTHETIC_JPEG, padding.byteLength);

    const thumbnail = extractJpegFromMp4(mp4Like.buffer);

    expect(thumbnail?.byteLength).toBe(SYNTHETIC_JPEG.byteLength);
  });

  it('ignores H.264 byte sequences that only look like JPEG boundaries', () => {
    const fake = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xd8, 0xff, 0x6f,
      0xde, 0xfd, 0xe9, 0x95, 0x1a, 0x96, 0x2a, 0x46, 0xff, 0xd9,
    ]);

    expect(extractJpegFromMp4(fake.buffer)).toBeNull();
  });
});

describe('processImage', () => {
  const buffer = new Uint8Array([0, 1, 2]).buffer;

  it('always resizes to the max width without upscaling', async () => {
    const images = createFakeImagesBinding();
    await processImage(images, buffer);

    expect(images.calls[0]).toEqual([
      'transform',
      { width: 1080, fit: 'scale-down' },
    ]);
    expect(images.calls.some((c) => c[0] === 'draw')).toBe(false);
    expect(images.calls.at(-1)).toEqual([
      'output',
      { format: 'image/jpeg', quality: 88 },
    ]);
  });

  it('draws a watermark sized and positioned off the max width when provided', async () => {
    const images = createFakeImagesBinding();
    const watermarkB64 = Buffer.from(new Uint8Array([9, 9, 9])).toString(
      'base64',
    );
    await processImage(images, buffer, { watermarkB64 });

    const drawCall = images.calls.find((c) => c[0] === 'draw');
    expect(drawCall?.[1]).toEqual({ bottom: 27, right: 27 });
  });
});
