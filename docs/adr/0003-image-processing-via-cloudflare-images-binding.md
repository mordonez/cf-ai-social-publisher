# 0003 — Image processing via the Cloudflare Images binding

**Status**: Accepted

## Context

`processImage` (resize, watermark, and originally an HDR-ish filter) ran entirely in-Worker: decode the JPEG/PNG at full resolution with `@jsquash/jpeg`/`@jsquash/png` (pure WASM, no hardware acceleration), then resize/composite/re-encode. This broke in production: a real 3.6MB phone photo got stuck retrying every 30s in the queue with `Exceeded CPU Limit`, confirmed live via `wrangler tail` against `instagram-sheriff`.

Root cause: the Workers **Free** plan hard-caps CPU time at 10ms per invocation, not configurable (Paid raises it to 30s+, but upgrading was explicitly rejected — the project's whole premise is running on Cloudflare's free tiers). Decoding a real phone photo in WASM routinely takes tens to hundreds of milliseconds — no in-Worker code change was going to fit that in 10ms. Worse, a CPU-limit-exceeded abort is a runtime-level isolate kill, not a catchable JS exception, so the existing `try/catch`-and-fall-back-to-raw-bytes safety net never even ran.

## Decision

Replace the in-Worker codec with Cloudflare's **Images binding** (`env.IMAGE_TRANSFORM.input(stream).transform(...).draw(...).output(...)`):

- Runs entirely outside the Worker's CPU budget — it's metered separately, not part of the 10ms limit.
- Has a genuine free tier (5,000 transformations/month, including R2-sourced images) — no paid Workers or Images plan required.
- Covers everything the old pipeline did: resize (`transform({width, fit: 'scale-down'})`) and watermark overlay (`.draw(overlayInput, { bottom, right })`).
- Watermark sizing is computed off the fixed target width (1080px) rather than the actual post-resize dimensions, to avoid a second, separately-billed `.info()` call. This only under-sizes the watermark for source images already narrower than 1080px — real phone photos never are.
- Dropped the HDR filter entirely rather than reimplementing it via the binding's `contrast`/`saturation` knobs — it wasn't providing enough value to justify keeping, even as an approximation.
- `@jsquash/jpeg`, `@jsquash/png`, and the `.wasm`-stubbing vitest workaround they required are removed, not kept around for compatibility — nothing depends on this package yet, so there's no cost to a clean break.

## Consequences

- Breaking change: `processImage(images, buffer, options)` now takes the Images binding as its first argument (auto-detects input format, so `mimeType` is gone too). `InstagramWorkerEnv` needs a new required `IMAGE_TRANSFORM` binding (`wrangler.jsonc`: `"images": { "binding": "IMAGE_TRANSFORM" }`).
- Image processing now makes a real network round-trip per image (seconds, not milliseconds) — irrelevant to the caller since it already runs inside the async queue consumer ([0002](./0002-unified-async-post-queue.md)), not the request path.
- Local `wrangler dev` only emulates `width`/`height`/`rotate`/`format` for this binding — watermark drawing needs `"remote": true` on the binding (or `wrangler dev --remote`) to test against the real service.
- No more HDR option, anywhere in the config or API.
