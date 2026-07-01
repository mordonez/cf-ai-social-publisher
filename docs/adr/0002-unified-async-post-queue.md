# 0002 — Unified async post queue

**Status**: Accepted

## Context

Before this decision, video and image posts had different architectures: video did AI captioning, frame extraction, and Instagram container creation synchronously in the `/post` handler, then queued only the "wait for FINISHED + publish" step. Images did _everything_ synchronously in the handler — including, once carousels existed ([0001](./0001-instagram-carousel-support.md)), creating and polling up to 10 Instagram containers inside one HTTP request. That risks Workers execution limits and gives inconsistent latency depending on post type.

## Decision

Every post type goes through the same pipeline:

1. `/post` validates the request, uploads the raw file(s) to R2 untouched, enqueues one `PostJob`, and returns `202 { status, type, message }` immediately — no `caption`/`post_id` in the response, since nothing currently consumes them synchronously.
2. A single queue consumer does all of the AI captioning, image processing, Instagram container creation/polling, and publishing, dispatched by `job.type`.
3. **Image/carousel** is single-phase: fetch → caption (if not supplied) → process each image ([0003](./0003-image-processing-via-cloudflare-images-binding.md)) → publish → ack → clean up R2. On failure, only the disposable _processed_ copies are deleted — the raw originals survive so a retry reprocesses from an untouched source.
4. **Video** stays two-phase, because Instagram's own processing takes minutes and phase 1's work (frame extraction, transcription, container creation) must not repeat on every 30s poll: phase 1 creates the container and re-enqueues a phase-2 job carrying `container_id`; phase 2 just polls and publishes.
5. `dry_run=1` stays fully synchronous and never touches the queue — it's a preview/test path, not a real post.
6. Success acks the queue message _before_ best-effort R2 cleanup, not after — cleanup failing after a successful publish must never trigger a retry, which would risk a duplicate post.

## Consequences

- Breaking change: real (non-`dry_run`) `/post` responses no longer carry `caption` or `post_id`. Any caller reading those fields needs to stop.
- Slower perceived completion for the caller (fire-and-forget instead of "here's your post_id"), traded for bounded, consistent request latency regardless of carousel size or video length.
- One added queue hop for video (phase 1 → phase 2) that didn't exist before, in exchange for treating all three post types the same way.
- Known accepted edge case: if enqueueing the phase-2 video job fails right after container creation succeeds, phase 1 retries and creates an orphaned duplicate Instagram container, which simply expires unpublished after ~24h. Not engineered around — low probability, low impact at this project's scale.
