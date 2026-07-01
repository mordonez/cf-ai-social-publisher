# cf-ai-social-publisher

A Cloudflare Workers toolkit for publishing to social media with AI-generated captions: a vision model describes the photo/video, an LLM writes the caption in your own voice, then it gets published for you.

**Today it ships with Instagram support**; the name is deliberately provider-agnostic because the publishing layer is small and isolated (see [Escape hatch](#escape-hatch-building-blocks) below) — a second provider would be a contained addition, not a rewrite.

Includes:

- **Real publishing** to Instagram (Graph API): photos, videos/Reels via container + queue, access token refresh.
- **Caption generation**: a vision model describes the scene, an LLM writes the caption using your persona.
- **Image processing**: resize, optional HDR, watermark compositing.
- **Video frame extraction** (via Browser Rendering) when a video has no embedded thumbnail.
- **Audio transcription**: a video's audio track is transcribed (Whisper) and fed into the caption prompt alongside the frame descriptions — no manual audio extraction needed, the model reads the video container directly.
- **`createInstagramWorker(config)`**: a complete Worker (health check, auth, `/caption`, `/preview`, `/post`, video queue) ready to deploy with ~10 lines of your own code.

## Quick start

Requirements: a Cloudflare account (Workers AI, R2, Queues, Browser Rendering — all within the free plan), and an API token with `Workers R2 Storage:Edit` + `Workers Queues:Edit` permissions (create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)).

Copy and paste this into your terminal (edit the 3 variables at the top first):

```bash
export WORKER_NAME="my-instagram-worker"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"      # dash.cloudflare.com → right sidebar
export CLOUDFLARE_API_TOKEN="your-token-with-r2-and-queues-permissions"

# 1. Scaffold the worker with Cloudflare's official CLI (non-interactive)
npm create cloudflare@latest "$WORKER_NAME" -- --type hello-world --lang ts --no-deploy --no-git
cd "$WORKER_NAME"
rm -f wrangler.jsonc src/index.ts

# 2. C3 templates currently pin an older Wrangler (v3) whose Queues API call
#    fails with "The specified queue settings are invalid." — make sure you're on v4+.
npm install -D wrangler@4

# 3. Install this library
npm install cf-ai-social-publisher

# 4. Generate wrangler.jsonc with the right bindings, and provision the
#    resources on Cloudflare
BUCKET="${WORKER_NAME}-images"
QUEUE="${WORKER_NAME}-video-queue"

cat > wrangler.jsonc <<EOF
{
	"name": "${WORKER_NAME}",
	"main": "src/index.ts",
	"compatibility_date": "$(date +%Y-%m-%d)",
	"compatibility_flags": ["nodejs_compat"],
	"account_id": "${CLOUDFLARE_ACCOUNT_ID}",
	"vars": {
		// TODO: replace with your real Instagram Business Account ID (Meta for Developers)
		"INSTAGRAM_BUSINESS_ACCOUNT_ID": "REPLACE_ME",
		"R2_PUBLIC_URL": "REPLACE_ME",
	},
	"r2_buckets": [{ "binding": "IMAGES", "bucket_name": "${BUCKET}" }],
	"queues": {
		"producers": [{ "binding": "VIDEO_QUEUE", "queue": "${QUEUE}" }],
		"consumers": [{ "queue": "${QUEUE}", "max_batch_size": 1, "max_retries": 20, "retry_delay": 30 }]
	},
	"ai": { "binding": "AI" },
	"browser": { "binding": "BROWSER" },
	"observability": { "enabled": true, "logs": { "invocation_logs": true, "head_sampling_rate": 1 } }
}
EOF

npx wrangler r2 bucket create "$BUCKET"
npx wrangler r2 bucket dev-url enable "$BUCKET"
npx wrangler queues create "$QUEUE"

PUBLIC_URL=$(npx wrangler r2 bucket dev-url get "$BUCKET" 2>&1 | grep -oE 'https://[a-zA-Z0-9.-]+\.r2\.dev' | head -1)
sed -i.bak "s|\"R2_PUBLIC_URL\": \"REPLACE_ME\"|\"R2_PUBLIC_URL\": \"${PUBLIC_URL}\"|" wrangler.jsonc && rm -f wrangler.jsonc.bak

echo "✓ Done. wrangler.jsonc generated, bucket + queue created on Cloudflare."
```

### What's left to do by hand (not automatable)

1. Your real `INSTAGRAM_BUSINESS_ACCOUNT_ID` in `wrangler.jsonc` — obtained by registering your app on [Meta for Developers](https://developers.facebook.com/).
2. A `.dev.vars` file with `INSTAGRAM_ACCESS_TOKEN` (your long-lived Instagram token) and `API_KEY` (any secret you choose to protect the Worker).
3. `src/index.ts` and `src/persona.ts` — see the example below.
4. `npm run deploy` (add that script to your `package.json`: `"deploy": "wrangler deploy"`).

### `src/persona.ts`

```ts
import type { PersonaConfig } from 'cf-ai-social-publisher';

export const persona: PersonaConfig = {
  describeImagePrompt: 'Describe the scene in 3 short sentences...',
  describeVideoFramePrompt: 'Describe this frame in 2 short sentences...',
  captionSystemPrompt: 'You are the Instagram account of... Write a caption with this tone...',
  fallbackCaption: 'New post 📸',

  // Optional — default to llama-3.2-11b-vision-instruct / llama-3.3-70b-instruct-fp8-fast / whisper-large-v3-turbo
  // visionModel: '@cf/meta/llama-3.2-11b-vision-instruct',
  // captionModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  // transcriptionModel: '@cf/openai/whisper-large-v3-turbo',
};
```

### `src/index.ts`

```ts
import { createInstagramWorker } from 'cf-ai-social-publisher';
import { persona } from './persona';
import { WATERMARK_PNG_B64 } from './watermark-data'; // your watermark, base64-encoded

export default createInstagramWorker({
  persona,
  watermarkB64: WATERMARK_PNG_B64,
  workerName: 'my-instagram-worker',           // same "name" as in wrangler.jsonc
  deployTokenEnvVar: 'CLOUDFLARE_API_TOKEN',   // only used in the /refresh-token helper message
  // videoProcessingMessage: 'Your video is being processed...', // optional, defaults to English
});
```

This gives you 5 endpoints already protected by `Authorization: Bearer <API_KEY>` (except `/health`): `/health`, `/refresh-token`, `/caption`, `/preview`, `/post`.

## Try it locally

```bash
npx wrangler dev
# or, if you added a `"dev": "wrangler dev"` script to package.json:
npm run dev
```

```bash
# Health check — no auth required
curl -s http://localhost:8787/health

# Caption only — describes the image and writes a caption, no publishing
curl -s -X POST http://localhost:8787/caption \
  -H "Authorization: Bearer $API_KEY" \
  -F "image=@photo.jpg" | jq .

# Preview — resize + watermark, returns the processed JPEG (add caption=1 for AI caption too)
curl -s -X POST http://localhost:8787/preview \
  -H "Authorization: Bearer $API_KEY" \
  -F "image=@photo.jpg" \
  -F "caption=1" \
  -o preview.jpg -D - | grep -i x-caption

# Post with dry_run=1 — runs the whole pipeline (caption + R2 upload) but stops
# before calling Instagram. Works for both images and video.
curl -s -X POST http://localhost:8787/post \
  -H "Authorization: Bearer $API_KEY" \
  -F "image=@photo.jpg" \
  -F "dry_run=1" | jq .
```

What actually runs in local dev (Miniflare) vs. production:

| Endpoint | AI (caption) | Resize + watermark | Uploads to R2 | Publishes to Instagram |
|---|:---:|:---:|:---:|:---:|
| `/health` | — | — | — | — |
| `/caption` | ✅ | — | — | — |
| `/preview` | ✅ (optional) | ✅ | — | — |
| `/post` image, `dry_run=1` | ✅ | — | — | ❌ (skipped by design) |
| `/post` image, real | ✅ | ✅ | ✅ | ⚠️ needs a real, publicly reachable R2 URL |
| `/post` video, `dry_run=1` | ✅ (thumbnail/frames) | — | ✅ (then deleted) | ❌ (skipped by design) |
| `/post` video, real | ✅ | — | ✅ | ⚠️ container is created, but the queue consumer that polls and publishes it **does not run in local dev** — only in production |

## Escape hatch: building blocks

`createInstagramWorker` covers the common case (one persona, those 5 routes). If you need different routes or a different auth model, build your own Hono app from the exported building blocks directly: `generateCaption`, `generateCaptionFromImages`, `publishToInstagram`, `createVideoContainer`, `checkContainerStatus`, `publishFromContainer`, `processImage`, `extractJpegFromMp4`, `extractVideoFrames`, `transcribeVideoAudio`.

## `PersonaConfig`

| Field | Required | Description |
|---|---|---|
| `describeImagePrompt` | yes | Prompt for the vision model when describing a photo. |
| `describeVideoFramePrompt` | yes | Prompt for the vision model when describing a video frame. |
| `captionSystemPrompt` | yes | System prompt for the LLM that writes the caption from the description. |
| `fallbackCaption` | yes | Emergency caption used if the AI call fails. |
| `visionModel` | no | Workers AI model used to describe images. Defaults to `@cf/meta/llama-3.2-11b-vision-instruct`. |
| `captionModel` | no | Workers AI model used to write the caption. Defaults to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. |
| `transcriptionModel` | no | Workers AI model used to transcribe a video's audio track. Defaults to `@cf/openai/whisper-large-v3-turbo`. |

## Observability: where to look

| What | Where |
|---|---|
| Worker dashboard (metrics, recent invocations, settings) | [dash.cloudflare.com → Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) |
| Real-time logs (`wrangler tail`, or the dashboard "Live" tab) | [Real-time logs docs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) |
| Persisted logs (7-day retention, enabled by this template's `observability` block) | [Workers Logs docs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Workers AI model catalog (capabilities, context size, pricing) | [developers.cloudflare.com/workers-ai/models](https://developers.cloudflare.com/workers-ai/models/) |
| Workers AI changelog (model deprecations) | [developers.cloudflare.com/changelog/product/workers-ai](https://developers.cloudflare.com/changelog/product/workers-ai/) |
| R2 dashboard (bucket contents, usage) | [dash.cloudflare.com → R2](https://dash.cloudflare.com/?to=/:account/r2/overview) |
| Queues docs | [developers.cloudflare.com/queues](https://developers.cloudflare.com/queues/) |
| Browser Rendering docs | [developers.cloudflare.com/browser-rendering](https://developers.cloudflare.com/browser-rendering/) |

As of this writing, a batch of Workers AI model deprecations lands **May 30, 2026**, but this library's defaults (`@cf/meta/llama-3.2-11b-vision-instruct` for vision, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for captioning) are **not** on that list — both stay active. Check the changelog link above before upgrading in case that changes.

## Free tier

Everything below fits inside Cloudflare's Workers Free plan for personal/low-volume use. Limits current as of this writing — always double check the linked docs, as free-tier terms have changed more than once (e.g. Queues moved onto the free plan in Feb 2026).

| Resource | Free limit | Notes |
|---|---|---|
| Workers | 100,000 requests/day · 10 ms CPU/request | Most requests here finish well under 10 ms unless HDR processing is enabled. |
| R2 storage | 10 GB-month | Files are typically deleted right after publishing, so steady-state usage stays near 0. |
| R2 operations | 1M Class A (writes) + 10M Class B (reads) per month | One post = ~2-4 operations (put + delete, plus retries for video). |
| Workers AI | 10,000 neurons/day (shared across the whole account) | A vision + caption call for one post costs roughly a few hundred to ~2,000 neurons depending on model and image size. Audio transcription (video posts) adds ~47 neurons per minute of video — negligible next to the vision/caption cost. |
| Queues | 10,000 operations/day (reads + writes + deletes combined), up to 10,000 queues, 24h max retention on the free tier | Only used for the video-publishing flow; each video is a handful of operations (1 send + status-check retries). |
| Browser Rendering | 10 minutes/day, 3 concurrent browsers | Only invoked when a video has no embedded thumbnail and frames must be extracted. |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [R2 limits](https://developers.cloudflare.com/r2/platform/limits/), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Queues changelog](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/), [Browser Rendering pricing](https://developers.cloudflare.com/changelog/post/2025-07-28-br-pricing/).

## Troubleshooting

- **Queue creation fails with "The specified queue settings are invalid."** — you're on Wrangler v3 from the C3 template; see the note in [Quick start](#quick-start) (step 2) — upgrade to Wrangler v4+.
- **401 on any endpoint** — the `Authorization: Bearer <API_KEY>` header doesn't match the `API_KEY` secret. Check `.dev.vars` locally, or `wrangler secret put API_KEY` in production; there's no way to bypass auth on any route except `/health`.
- **Instagram can't fetch the image/video ("media URL not accessible" or similar)** — the R2 bucket needs Public Access enabled: `npx wrangler r2 bucket dev-url enable <bucket-name>` (the Quick start script already does this, but double-check if you created the bucket manually).
- **Video posts never get published in local dev** — expected. The video queue consumer that polls Instagram and finishes the publish only runs in production; `dry_run=1` is the way to test the video pipeline locally (see [Try it locally](#try-it-locally)).

## License

MIT
