import { timingSafeEqual } from 'node:crypto';

// crypto.subtle.timingSafeEqual is Cloudflare Workers-specific; polyfill for Node test env
Object.defineProperty(globalThis.crypto.subtle, 'timingSafeEqual', {
  value: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(Buffer.from(a), Buffer.from(b)),
  configurable: true,
});
