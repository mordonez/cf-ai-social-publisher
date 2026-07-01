import decode, { init as initJpegDecode } from '@jsquash/jpeg/decode';
import encode, { init as initJpegEncode } from '@jsquash/jpeg/encode';
import decodePng, { init as initPngDecode } from '@jsquash/png/decode';
// Wrangler bundles .wasm as WebAssembly.Module; explicit init() bypasses the fetch path that fails in miniflare.
import jpegDecWasm from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import jpegEncWasm from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
// @ts-ignore — squoosh_png_bg.wasm.d.ts declares wasm-instance exports, not the module object
import pngDecWasm from '@jsquash/png/codec/pkg/squoosh_png_bg.wasm';
import { Buffer } from 'node:buffer';

let wasmReady: Promise<void> | null = null;

function ensureWasmReady(): Promise<void> {
  wasmReady ??= Promise.all([
    initJpegDecode(jpegDecWasm as unknown as WebAssembly.Module),
    initJpegEncode(jpegEncWasm as unknown as WebAssembly.Module),
    initPngDecode(pngDecWasm),
  ]).then(() => undefined);
  return wasmReady;
}

let wmCache: ImageData | null = null;
let wmB64Cached: string | null = null;

async function getWatermark(watermarkB64: string): Promise<ImageData> {
  if (wmCache && wmB64Cached === watermarkB64) return wmCache;
  const bytes = Buffer.from(watermarkB64, 'base64');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  wmCache = await decodePng(buf as ArrayBuffer);
  wmB64Cached = watermarkB64;
  return wmCache;
}

function compositeWatermark(image: ImageData, wm: ImageData): void {
  const { width: iw, height: ih } = image;
  const { width: wmW, height: wmH, data: wmData } = wm;

  const targetW = Math.min(wmW, Math.round(iw * 0.28));
  const scale = targetW / wmW;
  const targetH = Math.round(wmH * scale);
  const margin = Math.round(iw * 0.025);
  const x0 = iw - targetW - margin;
  const y0 = ih - targetH - margin;
  const imgData = image.data;

  for (let dy = 0; dy < targetH; dy++) {
    const iy = y0 + dy;
    if (iy < 0 || iy >= ih) continue;
    const wy = Math.min(wmH - 1, Math.round(dy / scale));
    for (let dx = 0; dx < targetW; dx++) {
      const ix = x0 + dx;
      if (ix < 0 || ix >= iw) continue;
      const wx = Math.min(wmW - 1, Math.round(dx / scale));
      const wmi = (wy * wmW + wx) * 4;
      const a = wmData[wmi + 3] / 255;
      if (a === 0) continue;
      const imi = (iy * iw + ix) * 4;
      imgData[imi] = Math.round(imgData[imi] * (1 - a) + wmData[wmi] * a);
      imgData[imi + 1] = Math.round(
        imgData[imi + 1] * (1 - a) + wmData[wmi + 1] * a,
      );
      imgData[imi + 2] = Math.round(
        imgData[imi + 2] * (1 - a) + wmData[wmi + 2] * a,
      );
    }
  }
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

// Nearest-neighbor downscale to maxW if larger. Reduces encode CPU on large photos.
function resizeDown(src: ImageData, maxW: number): ImageData {
  if (src.width <= maxW) return src;
  const scale = maxW / src.width;
  const dstH = Math.round(src.height * scale);
  const dst = new Uint8ClampedArray(maxW * dstH * 4);
  const sw = src.width,
    sd = src.data;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.min(src.height - 1, Math.round(dy / scale));
    for (let dx = 0; dx < maxW; dx++) {
      const sx = Math.min(sw - 1, Math.round(dx / scale));
      const si = (sy * sw + sx) * 4;
      const di = (dy * maxW + dx) * 4;
      dst[di] = sd[si];
      dst[di + 1] = sd[si + 1];
      dst[di + 2] = sd[si + 2];
      dst[di + 3] = sd[si + 3];
    }
  }
  return {
    data: dst,
    width: maxW,
    height: dstH,
    colorSpace: src.colorSpace,
  } as unknown as ImageData;
}

function buildLut(fn: (x: number) => number): Uint8Array {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++)
    lut[i] = Math.max(0, Math.min(255, Math.round(fn(i))));
  return lut;
}

// S-curve through (0,0)→(128,128)→(255,255); max deviation ≈ amplitude/12 at x=64 and x=192.
function sc(x: number, amplitude: number): number {
  const t = x / 255;
  return x + amplitude * t * (1 - t) * (2 * t - 1);
}

// Signature HDR: S-curve clarity + warm shadow lift + ×1.3 saturation.
const HDR_R = buildLut((x) => sc(x, 150) + Math.round(8 * (1 - x / 255)));
const HDR_G = buildLut((x) => sc(x, 150) + Math.round(2 * (1 - x / 255)));
const HDR_B = buildLut((x) => sc(x, 150) - Math.round(5 * (1 - x / 255)));
const HDR_SAT = 333; // 333/256 ≈ ×1.3

function applyHdr(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    let r = HDR_R[data[i]];
    let g = HDR_G[data[i + 1]];
    let b = HDR_B[data[i + 2]];
    // Rec. 601 luma coefficients scaled to sum=256 for integer arithmetic.
    const lum = (77 * r + 150 * g + 29 * b) >> 8;
    data[i] = lum + ((HDR_SAT * (r - lum)) >> 8);
    data[i + 1] = lum + ((HDR_SAT * (g - lum)) >> 8);
    data[i + 2] = lum + ((HDR_SAT * (b - lum)) >> 8);
  }
}

export async function processImage(
  buffer: ArrayBuffer,
  mimeType: string,
  options?: { hdr?: boolean; watermarkB64?: string },
): Promise<ArrayBuffer> {
  await ensureWasmReady();
  const imageData: ImageData =
    mimeType === 'image/png' ? await decodePng(buffer) : await decode(buffer);

  const sized = resizeDown(imageData, 1080);

  if (options?.hdr) applyHdr(sized.data);

  if (options?.watermarkB64) {
    try {
      const wm = await getWatermark(options.watermarkB64);
      compositeWatermark(sized, wm);
    } catch (e) {
      console.error(
        'watermark_failed',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  return encode(sized, { quality: 88 });
}
