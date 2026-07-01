# 0001 — Instagram carousel support

**Status**: Accepted

## Context

`/post` only accepted a single `image` file. Instagram supports posting up to 20 photos in one carousel post through the app, and we wanted `/post` to support that too, ideally without changing the request contract.

## Decision

- `/post` accepts multiple `image` form-data parts (same field name, repeated) — a client that already sends one `image` file needs zero changes.
- Also accept `image[]` as an alias. Some clients (confirmed for HTTP Shortcuts' "Multiple Files" parameter type, via its own source) always suffix the field name with `[]`, even for a single file — without this, those clients get a confusing `` `image` (file) is required `` for every request.
- Cap at **10** images per post, not 20. The 20-slide limit is a consumer-app UI limit; the Instagram Graph API's Content Publishing API (what this worker actually calls) caps carousels at 10 children. Enforcing 10 here avoids a confusing rejection from Meta after we've already uploaded and processed the images.
- Carousel captioning reuses `generateCaptionFromImages` (originally built for video frames) — it labels descriptions "Frame N" and uses the video-frame prompt, which is semantically wrong for photos. Known, not fixed: fixing it means adding a photo-specific multi-image prompt/labeling path in `caption.ts`, which is out of scope for adding carousel support itself.

## Consequences

- No client-facing contract change for existing single-image callers.
- A 10-image carousel means 10 Instagram container creations + polls per post (see [0002](./0002-unified-async-post-queue.md) for why that no longer blocks the HTTP response).
- The carousel caption quality is currently worse than it should be (wrong framing/prompt) until `caption.ts` gets a dedicated multi-photo path.
