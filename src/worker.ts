import { Hono } from 'hono';
import {
  publishToInstagram,
  createVideoContainer,
  checkContainerStatus,
  publishFromContainer,
} from './instagram';
import {
  generateCaption,
  generateCaptionFromImages,
  type PersonaConfig,
} from './caption';
import { processImage, extractJpegFromMp4 } from './image';
import { extractVideoFrames } from './video-frame';
import { transcribeVideoAudio } from './transcription';

export type PostJob = {
  type: 'image' | 'carousel' | 'video';
  /** Raw, untouched original file(s) as uploaded — 1 for image/video, 2-10 for carousel. */
  r2_keys: string[];
  /** Parallel to `r2_keys`. */
  mime_types: string[];
  /** User-supplied caption only; the consumer generates one via AI when absent. */
  caption?: string;
  /** Video only: absent = phase 1 (create the Instagram container), present = phase 2 (poll + publish). */
  container_id?: string;
};

export type InstagramWorkerEnv = {
  INSTAGRAM_BUSINESS_ACCOUNT_ID: string;
  INSTAGRAM_ACCESS_TOKEN: string;
  R2_PUBLIC_URL: string;
  API_KEY: string;
  IMAGES: R2Bucket;
  AI: Ai;
  /** Resize/watermark/color transforms run here, off the Worker's own CPU budget. */
  IMAGE_TRANSFORM: ImagesBinding;
  /** Every post type (image/carousel/video) is queued here. */
  POST_QUEUE: Queue<PostJob>;
  BROWSER?: Fetcher;
  HDR_ENABLED?: string;
};

export type InstagramWorkerConfig = {
  persona: PersonaConfig;
  /** Watermark PNG as base64, composited onto every published image/video frame. */
  watermarkB64: string;
  /** `name` field from wrangler.toml — shown in the /refresh-token helper message. */
  workerName: string;
  /** Shell env var holding this worker's Cloudflare API token — shown in the /refresh-token helper message. */
  deployTokenEnvVar: string;
  /** Message returned by /post while a post (image, carousel, or video) is queued for publishing. Defaults to an English message. */
  postProcessingMessage?: string;
};

const DEFAULT_POST_PROCESSING_MESSAGE =
  'Your post is being processed. It will be published automatically in a few minutes.';

// Instagram Graph API's Content Publishing API caps carousel posts at 10
// children (the Instagram app itself allows up to 20 slides, but that limit
// doesn't apply to the API this worker calls).
const MAX_IMAGES_PER_POST = 10;

/** Single image (`generateCaption`) or, for a carousel, one AI call per photo joined into a caption (`generateCaptionFromImages`). */
async function resolveImageCaption(
  buffers: ArrayBuffer[],
  mimeTypes: string[],
  ai: Ai,
  persona: PersonaConfig,
): Promise<string> {
  let caption = '';
  try {
    caption =
      buffers.length > 1
        ? await generateCaptionFromImages(
            buffers.map((buffer, i) => ({ buffer, mimeType: mimeTypes[i] })),
            ai,
            persona,
          )
        : await generateCaption(buffers[0], mimeTypes[0], ai, persona);
  } catch (e) {
    console.error(
      'caption_ai_failed',
      e instanceof Error ? e.message : String(e),
    );
  }
  return caption || persona.fallbackCaption;
}

type VideoCaptionResult = {
  caption: string;
  captionSource: string;
  frames: number;
};

async function resolveVideoCaption(
  videoBuffer: ArrayBuffer,
  videoUrl: string,
  env: InstagramWorkerEnv,
  persona: PersonaConfig,
): Promise<VideoCaptionResult> {
  // Kicked off before frame extraction so its network latency overlaps with it.
  const audioTranscriptPromise = transcribeVideoAudio(
    videoBuffer,
    env.AI,
    persona.transcriptionModel,
  ).catch((e) => {
    console.error(
      'audio_transcription_failed',
      e instanceof Error ? e.message : String(e),
    );
    return '';
  });

  let thumbnail = extractJpegFromMp4(videoBuffer);
  let frames: ArrayBuffer[] = [];
  let captionSource = 'fallback';
  if (thumbnail) {
    console.log(
      'video_thumbnail_found',
      `${Math.round(thumbnail.byteLength / 1024)}KB`,
    );
    frames = [thumbnail];
    captionSource = 'embedded_thumbnail';
  } else if (env.BROWSER) {
    console.log('video_extract_frames_start');
    try {
      frames = await extractVideoFrames(videoUrl, env.BROWSER, 3);
      console.log(
        'video_frames_extracted',
        frames.length,
        frames.map((f) => `${Math.round(f.byteLength / 1024)}KB`).join(','),
      );
      captionSource = frames.length > 1 ? 'browser_frames' : 'browser_frame';
    } catch (e) {
      console.error(
        'video_frames_extract_failed',
        e instanceof Error ? e.message : String(e),
      );
    }
  } else {
    console.log('video_no_thumbnail');
  }

  const audioTranscript = await audioTranscriptPromise;
  if (audioTranscript)
    console.log('video_audio_transcript', audioTranscript.slice(0, 200));

  let caption = '';
  if (frames.length > 0) {
    try {
      caption = await generateCaptionFromImages(
        frames.map((frame) => ({ buffer: frame, mimeType: 'image/jpeg' })),
        env.AI,
        persona,
        audioTranscript || undefined,
      );
    } catch (e) {
      console.error(
        'caption_ai_multi_frame_failed',
        e instanceof Error ? e.message : String(e),
      );
      try {
        caption = await generateCaption(
          frames[0],
          'image/jpeg',
          env.AI,
          persona,
        );
        captionSource = `${captionSource}_first_frame_fallback`;
      } catch (fallbackErr) {
        console.error(
          'caption_ai_failed',
          fallbackErr instanceof Error
            ? fallbackErr.message
            : String(fallbackErr),
        );
      }
    }
  }
  if (!caption) caption = persona.fallbackCaption;

  return { caption, captionSource, frames: frames.length };
}

/**
 * Batteries-included Instagram posting worker: health check, token refresh,
 * caption generation (photo/video), preview, and publish — wired to Hono +
 * a queue that does all AI captioning, image processing, Instagram
 * container creation/polling, and publishing for every post type (image,
 * carousel, video), off the request thread. Covers the common case (one
 * persona per account); for custom routes or a different auth model,
 * compose the exported building blocks (generateCaption, publishToInstagram,
 * processImage...) directly instead of this factory.
 */
export function createInstagramWorker(config: InstagramWorkerConfig) {
  const { persona, watermarkB64, workerName, deployTokenEnvVar } = config;
  const postProcessingMessage =
    config.postProcessingMessage ?? DEFAULT_POST_PROCESSING_MESSAGE;
  const app = new Hono<{ Bindings: InstagramWorkerEnv }>();

  app.get('/health', (c) => c.json({ ok: true }));

  app.use('*', async (c, next) => {
    const auth = c.req.header('Authorization') ?? '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const expected = c.env.API_KEY ?? '';
    const enc = new TextEncoder();
    const a = enc.encode(provided.padEnd(64));
    const b = enc.encode(expected.padEnd(64));
    const valid =
      (await crypto.subtle.timingSafeEqual(a, b)) &&
      provided.length === expected.length;
    if (!valid) return c.json({ error: 'Unauthorized' }, 401);
    await next();
  });

  app.post('/refresh-token', async (c) => {
    const token = c.env.INSTAGRAM_ACCESS_TOKEN;
    const url = new URL(
      'https://graph.instagram.com/v21.0/refresh_access_token',
    );
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', token);

    const res = await fetch(url.toString());
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: { message: string };
    };

    if (!res.ok || data.error) {
      return c.json(
        { error: data.error?.message ?? `HTTP ${res.status}` },
        502,
      );
    }

    const expiresInDays = Math.floor((data.expires_in ?? 0) / 86400);
    console.log(
      'token_refreshed',
      `expires_in=${expiresInDays}d`,
      `new_token=${data.access_token?.slice(0, 10)}...`,
    );

    return c.json({
      ok: true,
      expires_in_days: expiresInDays,
      new_token: data.access_token,
      instruction: `Copia new_token y ejecuta: echo "<token>" | CLOUDFLARE_API_TOKEN=$${deployTokenEnvVar} npx wrangler secret put INSTAGRAM_ACCESS_TOKEN --name ${workerName}`,
    });
  });

  app.post('/caption', async (c) => {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'Expected multipart/form-data' }, 400);
    }

    const image = formData.get('image');
    if (!(image instanceof File))
      return c.json({ error: '`image` (file) is required' }, 400);

    const imageBuffer = await image.arrayBuffer();
    try {
      const caption = await generateCaption(
        imageBuffer,
        image.type || 'image/jpeg',
        c.env.AI,
        persona,
      );
      return c.json({ caption: caption || persona.fallbackCaption });
    } catch (e) {
      console.error(
        'caption_ai_failed',
        e instanceof Error ? e.message : String(e),
      );
      return c.json({ caption: persona.fallbackCaption });
    }
  });

  app.post('/preview', async (c) => {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'Expected multipart/form-data' }, 400);
    }

    const image = formData.get('image');
    if (!(image instanceof File))
      return c.json({ error: '`image` (file) is required' }, 400);

    const imageBuffer = await image.arrayBuffer();
    const mimeType = image.type || 'image/jpeg';
    let caption = '';

    if (formData.get('caption') === '1') {
      try {
        caption = await generateCaption(
          imageBuffer,
          mimeType,
          c.env.AI,
          persona,
        );
      } catch (e) {
        console.error(
          'caption_ai_failed',
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    let processedBuffer: ArrayBuffer;
    try {
      processedBuffer = await processImage(c.env.IMAGE_TRANSFORM, imageBuffer, {
        hdr: c.env.HDR_ENABLED === '1',
        watermarkB64,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('img_process_failed', msg);
      return c.json({ error: `Image processing failed: ${msg}` }, 500);
    }

    return new Response(processedBuffer, {
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Caption': encodeURIComponent(caption.slice(0, 500)),
      },
    });
  });

  app.post('/post', async (c) => {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: 'Expected multipart/form-data' }, 400);
    }

    // Accept both `image` (repeated field name) and `image[]` — some HTTP
    // clients (e.g. HTTP Shortcuts' "Multiple Files" parameter type) always
    // suffix the field name with `[]`, even for a single file.
    const files = [
      ...formData.getAll('image'),
      ...formData.getAll('image[]'),
    ].filter((f): f is File => f instanceof File);
    const captionInput = formData.get('caption');
    const dryRun = formData.get('dry_run') === '1';
    if (files.length === 0)
      return c.json({ error: '`image` (file) is required' }, 400);
    if (files.length > MAX_IMAGES_PER_POST)
      return c.json(
        { error: `Maximum ${MAX_IMAGES_PER_POST} images per post` },
        400,
      );

    const file = files[0];
    const isVideo = file.type.startsWith('video/');
    if (isVideo && files.length > 1)
      return c.json({ error: 'Only one video allowed per post' }, 400);

    let caption = '';
    if (
      captionInput &&
      typeof captionInput === 'string' &&
      captionInput.trim()
    ) {
      caption = captionInput.trim();
    }

    if (isVideo) {
      const mimeType = file.type || 'video/mp4';
      const ext = file.name.split('.').pop() ?? 'mp4';
      const videoBuffer = await file.arrayBuffer();

      if (dryRun) {
        const key = `${crypto.randomUUID()}.${ext}`;
        await c.env.IMAGES.put(key, videoBuffer, {
          httpMetadata: { contentType: mimeType },
        });
        const videoUrl = `${c.env.R2_PUBLIC_URL}/${key}`;

        let captionSource = 'provided';
        let frameCount = 0;
        if (!caption) {
          const result = await resolveVideoCaption(
            videoBuffer,
            videoUrl,
            c.env,
            persona,
          );
          caption = result.caption;
          captionSource = result.captionSource;
          frameCount = result.frames;
        }

        await c.env.IMAGES.delete(key);
        return c.json({
          dry_run: true,
          type: 'video',
          caption,
          caption_source: captionSource,
          frames: frameCount,
        });
      }

      const key = `${crypto.randomUUID()}.${ext}`;
      await c.env.IMAGES.put(key, videoBuffer, {
        httpMetadata: { contentType: mimeType },
      });
      console.log(
        'r2_video_uploaded',
        key,
        `${Math.round(videoBuffer.byteLength / 1024)}KB`,
      );

      const job: PostJob = {
        type: 'video',
        r2_keys: [key],
        mime_types: [mimeType],
        caption: caption || undefined,
      };
      await c.env.POST_QUEUE.send(job);

      return c.json(
        { status: 'processing', type: 'video', message: postProcessingMessage },
        202,
      );
    }

    // Image / carousel flow
    const isCarousel = files.length > 1;
    const mimeTypes = files.map((f) => f.type || 'image/jpeg');
    const imageBuffers = await Promise.all(files.map((f) => f.arrayBuffer()));

    if (dryRun) {
      if (!caption) {
        caption = await resolveImageCaption(
          imageBuffers,
          mimeTypes,
          c.env.AI,
          persona,
        );
      }
      return c.json({
        dry_run: true,
        type: isCarousel ? 'carousel' : 'image',
        caption,
        images: files.length,
      });
    }

    const imageKeys: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const ext = files[i].name.split('.').pop() ?? 'jpg';
      const key = `${crypto.randomUUID()}.${ext}`;
      await c.env.IMAGES.put(key, imageBuffers[i], {
        httpMetadata: { contentType: mimeTypes[i] },
      });
      imageKeys.push(key);
    }
    console.log('r2_uploaded', imageKeys.join(','));

    const job: PostJob = {
      type: isCarousel ? 'carousel' : 'image',
      r2_keys: imageKeys,
      mime_types: mimeTypes,
      caption: caption || undefined,
    };
    await c.env.POST_QUEUE.send(job);

    return c.json(
      { status: 'processing', type: job.type, message: postProcessingMessage },
      202,
    );
  });

  async function processImageJob(
    msg: Message<PostJob>,
    env: InstagramWorkerEnv,
  ): Promise<void> {
    const job = msg.body;
    const buffers = await Promise.all(
      job.r2_keys.map(async (key) => {
        const obj = await env.IMAGES.get(key);
        if (!obj) throw new Error(`Missing R2 object: ${key}`);
        return obj.arrayBuffer();
      }),
    );

    const caption =
      job.caption ||
      (await resolveImageCaption(buffers, job.mime_types, env.AI, persona));

    const hdr = env.HDR_ENABLED === '1';
    const processedKeys: string[] = [];
    const imageUrls: string[] = [];

    try {
      for (let i = 0; i < buffers.length; i++) {
        const mimeType = job.mime_types[i];
        const rawExt = job.r2_keys[i].split('.').pop() ?? 'jpg';
        let processedBuffer: ArrayBuffer;
        let outputMimeType = 'image/jpeg';
        let outputExt = 'jpg';
        try {
          processedBuffer = await processImage(
            env.IMAGE_TRANSFORM,
            buffers[i],
            {
              hdr,
              watermarkB64,
            },
          );
        } catch (e) {
          console.error(
            'img_process_failed',
            e instanceof Error ? e.message : String(e),
          );
          processedBuffer = buffers[i];
          outputMimeType = mimeType;
          outputExt = rawExt;
        }

        const processedKey = `${crypto.randomUUID()}.${outputExt}`;
        await env.IMAGES.put(processedKey, processedBuffer, {
          httpMetadata: { contentType: outputMimeType },
        });
        processedKeys.push(processedKey);
        imageUrls.push(`${env.R2_PUBLIC_URL}/${processedKey}`);
      }

      const postId = await publishToInstagram(
        env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
        env.INSTAGRAM_ACCESS_TOKEN,
        job.type === 'carousel' ? imageUrls : imageUrls[0],
        caption,
      );
      console.log('published', postId);
    } catch (e) {
      // Only the disposable processed copies are cleaned up here — the raw
      // originals in job.r2_keys must survive so a retry can reprocess them.
      for (const key of processedKeys) {
        await env.IMAGES.delete(key).catch(() => {});
      }
      throw e;
    }

    msg.ack();
    for (const key of [...job.r2_keys, ...processedKeys]) {
      await env.IMAGES.delete(key).catch((e) =>
        console.error(
          'r2_cleanup_failed',
          key,
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
  }

  async function processVideoJob(
    msg: Message<PostJob>,
    env: InstagramWorkerEnv,
  ): Promise<void> {
    const job = msg.body;
    const r2_key = job.r2_keys[0];

    if (!job.container_id) {
      // Phase 1: resolve the caption and create the Instagram media container.
      const obj = await env.IMAGES.get(r2_key);
      if (!obj) throw new Error(`Missing R2 object: ${r2_key}`);
      const videoBuffer = await obj.arrayBuffer();
      const videoUrl = `${env.R2_PUBLIC_URL}/${r2_key}`;

      const caption =
        job.caption ||
        (await resolveVideoCaption(videoBuffer, videoUrl, env, persona))
          .caption;

      let container_id: string;
      try {
        container_id = await createVideoContainer(
          env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
          env.INSTAGRAM_ACCESS_TOKEN,
          videoUrl,
          caption,
        );
      } catch (e) {
        // Terminal: an unpublishable video won't become publishable on retry.
        console.error(
          'video_container_failed',
          e instanceof Error ? e.message : String(e),
        );
        await env.IMAGES.delete(r2_key).catch(() => {});
        msg.ack();
        return;
      }
      console.log('video_container_created', container_id);

      await env.POST_QUEUE.send({ ...job, caption, container_id });
      msg.ack();
      return;
    }

    // Phase 2: poll until Instagram finishes processing, then publish.
    const status = await checkContainerStatus(
      job.container_id,
      env.INSTAGRAM_ACCESS_TOKEN,
    );
    console.log('video_container_status', job.container_id, status);

    if (status === 'FINISHED') {
      const postId = await publishFromContainer(
        env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
        env.INSTAGRAM_ACCESS_TOKEN,
        job.container_id,
      );
      console.log('video_published', postId);
      msg.ack();
      await env.IMAGES.delete(r2_key).catch((e) =>
        console.error(
          'r2_cleanup_failed',
          r2_key,
          e instanceof Error ? e.message : String(e),
        ),
      );
    } else if (status === 'ERROR' || status === 'EXPIRED') {
      console.error('video_container_failed', job.container_id, status);
      await env.IMAGES.delete(r2_key).catch(() => {});
      msg.ack();
    } else {
      msg.retry({ delaySeconds: 30 });
    }
  }

  async function handlePostQueue(
    batch: MessageBatch<PostJob>,
    env: InstagramWorkerEnv,
  ): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (msg.body.type === 'video') {
          await processVideoJob(msg, env);
        } else {
          await processImageJob(msg, env);
        }
      } catch (e) {
        console.error(
          'queue_handler_failed',
          e instanceof Error ? e.message : String(e),
        );
        msg.retry({ delaySeconds: 30 });
      }
    }
  }

  return {
    fetch: app.fetch,
    queue: handlePostQueue,
  };
}
