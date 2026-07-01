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

export type VideoJob = {
  container_id: string;
  r2_key: string;
  caption: string;
};

export type InstagramWorkerEnv = {
  INSTAGRAM_BUSINESS_ACCOUNT_ID: string;
  INSTAGRAM_ACCESS_TOKEN: string;
  R2_PUBLIC_URL: string;
  API_KEY: string;
  IMAGES: R2Bucket;
  AI: Ai;
  VIDEO_QUEUE: Queue<VideoJob>;
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
  /** Message returned by /post while a video is queued for publishing. Defaults to an English message. */
  videoProcessingMessage?: string;
};

const DEFAULT_VIDEO_PROCESSING_MESSAGE =
  'Your video is being processed by Instagram. It will be published automatically in a few minutes.';

/**
 * Batteries-included Instagram posting worker: health check, token refresh,
 * caption generation (photo/video), preview, and publish — wired to Hono +
 * a video-processing queue. Covers the common case (one persona per
 * account); for custom routes or a different auth model, compose the
 * exported building blocks (generateCaption, publishToInstagram, processImage...)
 * directly instead of this factory.
 */
export function createInstagramWorker(config: InstagramWorkerConfig) {
  const { persona, watermarkB64, workerName, deployTokenEnvVar } = config;
  const videoProcessingMessage =
    config.videoProcessingMessage ?? DEFAULT_VIDEO_PROCESSING_MESSAGE;
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
      processedBuffer = await processImage(imageBuffer, mimeType, {
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

    const file = formData.get('image');
    const captionInput = formData.get('caption');
    const dryRun = formData.get('dry_run') === '1';
    if (!(file instanceof File))
      return c.json({ error: '`image` (file) is required' }, 400);

    const isVideo = file.type.startsWith('video/');
    const mimeType = file.type || (isVideo ? 'video/mp4' : 'image/jpeg');
    const ext = file.name.split('.').pop() ?? (isVideo ? 'mp4' : 'jpg');
    const key = `${crypto.randomUUID()}.${ext}`;

    const {
      INSTAGRAM_BUSINESS_ACCOUNT_ID: accountId,
      INSTAGRAM_ACCESS_TOKEN: accessToken,
    } = c.env;

    let caption = '';
    if (
      captionInput &&
      typeof captionInput === 'string' &&
      captionInput.trim()
    ) {
      caption = captionInput.trim();
    }

    if (isVideo) {
      const videoBuffer = await file.arrayBuffer();

      // Kicked off before the R2 upload so its network latency overlaps with
      // both the upload and the frame extraction below.
      const audioTranscriptPromise = caption
        ? Promise.resolve('')
        : transcribeVideoAudio(
            videoBuffer,
            c.env.AI,
            persona.transcriptionModel,
          ).catch((e) => {
            console.error(
              'audio_transcription_failed',
              e instanceof Error ? e.message : String(e),
            );
            return '';
          });

      await c.env.IMAGES.put(key, videoBuffer, {
        httpMetadata: { contentType: mimeType },
      });
      console.log(
        'r2_video_uploaded',
        key,
        `${Math.round(videoBuffer.byteLength / 1024)}KB`,
      );

      const videoUrl = `${c.env.R2_PUBLIC_URL}/${key}`;

      if (!caption) {
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
        } else if (c.env.BROWSER) {
          console.log('video_extract_frames_start');
          try {
            frames = await extractVideoFrames(videoUrl, c.env.BROWSER, 3);
            console.log(
              'video_frames_extracted',
              frames.length,
              frames
                .map((frame) => `${Math.round(frame.byteLength / 1024)}KB`)
                .join(','),
            );
            captionSource =
              frames.length > 1 ? 'browser_frames' : 'browser_frame';
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

        if (frames.length > 0) {
          try {
            caption = await generateCaptionFromImages(
              frames.map((frame) => ({
                buffer: frame,
                mimeType: 'image/jpeg',
              })),
              c.env.AI,
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
                c.env.AI,
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

        if (dryRun) {
          await c.env.IMAGES.delete(key);
          return c.json({
            dry_run: true,
            type: 'video',
            caption,
            caption_source: captionSource,
            frames: frames.length,
          });
        }
      } else if (dryRun) {
        await c.env.IMAGES.delete(key);
        return c.json({
          dry_run: true,
          type: 'video',
          caption,
          caption_source: 'provided',
          frames: 0,
        });
      }

      let container_id: string;
      try {
        container_id = await createVideoContainer(
          accountId,
          accessToken,
          videoUrl,
          caption,
        );
      } catch (err) {
        await c.env.IMAGES.delete(key);
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('video_container_failed', message);
        return c.json({ error: message }, 502);
      }
      console.log('video_container_created', container_id);

      await c.env.VIDEO_QUEUE.send({ container_id, r2_key: key, caption });

      return c.json(
        { status: 'processing', container_id, message: videoProcessingMessage },
        202,
      );
    }

    // Image flow
    const imageBuffer = await file.arrayBuffer();

    if (!caption) {
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
      if (!caption) caption = persona.fallbackCaption;
    }

    if (dryRun) {
      return c.json({ dry_run: true, type: 'image', caption });
    }

    const hdr = c.env.HDR_ENABLED === '1';
    let processedBuffer: ArrayBuffer;
    let outputMimeType = 'image/jpeg';
    let outputExt = 'jpg';
    try {
      processedBuffer = await processImage(imageBuffer, mimeType, {
        hdr,
        watermarkB64,
      });
      console.log(
        'img_processed',
        `hdr=${hdr}`,
        `${Math.round(processedBuffer.byteLength / 1024)}KB`,
      );
    } catch (e) {
      console.error(
        'img_process_failed',
        e instanceof Error ? e.message : String(e),
      );
      processedBuffer = imageBuffer;
      outputMimeType = mimeType;
      outputExt = ext;
    }

    const imageKey = `${crypto.randomUUID()}.${outputExt}`;
    await c.env.IMAGES.put(imageKey, processedBuffer, {
      httpMetadata: { contentType: outputMimeType },
    });
    console.log(
      'r2_uploaded',
      imageKey,
      `${Math.round(processedBuffer.byteLength / 1024)}KB`,
    );

    const imageUrl = `${c.env.R2_PUBLIC_URL}/${imageKey}`;

    try {
      const postId = await publishToInstagram(
        accountId,
        accessToken,
        imageUrl,
        caption,
      );
      console.log('published', postId);
      return c.json({ success: true, post_id: postId, caption });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('post_failed', message);
      return c.json({ error: message }, 502);
    } finally {
      await c.env.IMAGES.delete(imageKey);
    }
  });

  async function handleVideoQueue(
    batch: MessageBatch<VideoJob>,
    env: InstagramWorkerEnv,
  ): Promise<void> {
    for (const msg of batch.messages) {
      const { container_id, r2_key, caption } = msg.body;
      try {
        const status = await checkContainerStatus(
          container_id,
          env.INSTAGRAM_ACCESS_TOKEN,
        );
        console.log('video_container_status', container_id, status);

        if (status === 'FINISHED') {
          const postId = await publishFromContainer(
            env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
            env.INSTAGRAM_ACCESS_TOKEN,
            container_id,
          );
          console.log('video_published', postId);
          await env.IMAGES.delete(r2_key);
          msg.ack();
        } else if (status === 'ERROR' || status === 'EXPIRED') {
          console.error('video_container_failed', container_id, status);
          await env.IMAGES.delete(r2_key);
          msg.ack();
        } else {
          msg.retry({ delaySeconds: 30 });
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
    queue: handleVideoQueue,
  };
}
