import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInstagramWorker, type PostJob } from './worker';
import type { PersonaConfig } from './caption';

function createFakeImagesBinding() {
  const chain = {
    transform: () => chain,
    draw: () => chain,
    output: async () => ({
      response: () => new Response(new Uint8Array([1, 2, 3]).buffer),
    }),
  };
  return { input: () => chain } as unknown as ImagesBinding;
}

const dummyPersona: PersonaConfig = {
  describeImagePrompt: 'describe',
  describeVideoFramePrompt: 'describe frame',
  captionSystemPrompt: 'write a caption',
  fallbackCaption: 'fallback',
};

const worker = createInstagramWorker({
  persona: dummyPersona,
  watermarkB64: '',
  workerName: 'test-worker',
  deployTokenEnvVar: 'TEST_TOKEN',
});

function createFakeR2() {
  const store = new Map<string, ArrayBuffer>();
  return {
    store,
    put: vi.fn(async (key: string, value: ArrayBuffer) => {
      store.set(key, value);
    }),
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      if (!value) return null;
      return { arrayBuffer: async () => value } as unknown as R2ObjectBody;
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

const fakeAi = {
  run: async (_model: string, input: any) => {
    if (input?.audio !== undefined) return { text: '' };
    return { response: 'a mocked description' };
  },
} as unknown as Ai;

function baseEnv() {
  return {
    INSTAGRAM_BUSINESS_ACCOUNT_ID: 'acct_1',
    INSTAGRAM_ACCESS_TOKEN: 'token_1',
    R2_PUBLIC_URL: 'https://example.r2.dev',
    API_KEY: 'secret',
    IMAGES: createFakeR2(),
    AI: fakeAi,
    IMAGE_TRANSFORM: createFakeImagesBinding(),
    POST_QUEUE: { send: vi.fn(async () => {}) },
  } as any;
}

function req(path: string, env: any, init?: RequestInit) {
  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    env,
    {} as any,
  );
}

function authedForm(formData: FormData) {
  return {
    method: 'POST',
    headers: { Authorization: 'Bearer secret' },
    body: formData,
  };
}

function fakeMessage(body: PostJob) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('GET /health', () => {
  it('is public — no auth required', async () => {
    const res = await req('/health', { API_KEY: 'secret' });
    expect(res.status).toBe(200);
  });
});

describe('auth middleware', () => {
  it('blocks requests with no token', async () => {
    const res = await req(
      '/caption',
      { API_KEY: 'secret' },
      { method: 'POST' },
    );
    expect(res.status).toBe(401);
  });

  it('blocks requests with wrong token', async () => {
    const res = await req(
      '/caption',
      { API_KEY: 'secret' },
      { method: 'POST', headers: { Authorization: 'Bearer wrong' } },
    );
    expect(res.status).toBe(401);
  });

  it('passes auth with correct token', async () => {
    const res = await req(
      '/caption',
      { API_KEY: 'secret' },
      { method: 'POST', headers: { Authorization: 'Bearer secret' } },
    );
    expect(res.status).not.toBe(401); // 400 (missing form data) but auth passed
  });
});

describe('POST /post — dry_run', () => {
  it('previews a single image without touching R2 or the queue', async () => {
    const env = baseEnv();
    const form = new FormData();
    form.set('image', new File(['abc'], 'photo.jpg', { type: 'image/jpeg' }));
    form.set('dry_run', '1');

    const res = await req('/post', env, authedForm(form));
    const body = (await res.json()) as any;

    expect(body).toMatchObject({ dry_run: true, type: 'image', images: 1 });
    expect(typeof body.caption).toBe('string');
    expect(env.IMAGES.put).not.toHaveBeenCalled();
    expect(env.POST_QUEUE.send).not.toHaveBeenCalled();
  });

  it('accepts `image[]` — some clients (e.g. HTTP Shortcuts) always suffix the field name', async () => {
    const env = baseEnv();
    const form = new FormData();
    form.append(
      'image[]',
      new File(['abc'], 'photo.jpg', { type: 'image/jpeg' }),
    );
    form.set('dry_run', '1');

    const res = await req('/post', env, authedForm(form));
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ dry_run: true, type: 'image', images: 1 });
  });

  it('previews a carousel when several `image` parts are sent', async () => {
    const env = baseEnv();
    const form = new FormData();
    form.append('image', new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
    form.append('image', new File(['b'], 'b.jpg', { type: 'image/jpeg' }));
    form.set('dry_run', '1');

    const res = await req('/post', env, authedForm(form));
    const body = (await res.json()) as any;

    expect(body).toMatchObject({ dry_run: true, type: 'carousel', images: 2 });
    expect(env.POST_QUEUE.send).not.toHaveBeenCalled();
  });

  it('rejects more than the max images per post', async () => {
    const env = baseEnv();
    const form = new FormData();
    for (let i = 0; i < 11; i++) {
      form.append(
        'image',
        new File([`${i}`], `${i}.jpg`, { type: 'image/jpeg' }),
      );
    }
    form.set('dry_run', '1');

    const res = await req('/post', env, authedForm(form));
    expect(res.status).toBe(400);
  });

  it('previews a video, uploading and cleaning up its temp R2 object', async () => {
    const env = baseEnv();
    const form = new FormData();
    form.set(
      'image',
      new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4' }),
    );
    form.set('dry_run', '1');

    const res = await req('/post', env, authedForm(form));
    const body = (await res.json()) as any;

    expect(body).toMatchObject({ dry_run: true, type: 'video' });
    expect(typeof body.caption).toBe('string');
    expect(typeof body.caption_source).toBe('string');
    expect(env.IMAGES.put).toHaveBeenCalledTimes(1);
    expect(env.IMAGES.delete).toHaveBeenCalledTimes(1);
    expect(env.POST_QUEUE.send).not.toHaveBeenCalled();
  });
});

describe('POST /post — real (non-dry-run)', () => {
  it('queues an image job and responds 202 with no caption/post_id', async () => {
    const env = baseEnv();
    const form = new FormData();
    form.set('image', new File(['abc'], 'photo.jpg', { type: 'image/jpeg' }));

    const res = await req('/post', env, authedForm(form));
    const body = (await res.json()) as any;

    expect(res.status).toBe(202);
    expect(body).toMatchObject({ status: 'processing', type: 'image' });
    expect(body).not.toHaveProperty('caption');
    expect(body).not.toHaveProperty('post_id');

    expect(env.POST_QUEUE.send).toHaveBeenCalledTimes(1);
    const job: PostJob = env.POST_QUEUE.send.mock.calls[0][0];
    expect(job.type).toBe('image');
    expect(job.r2_keys).toHaveLength(1);
    expect(job.mime_types).toEqual(['image/jpeg']);
    expect(job.caption).toBeUndefined();
    // AI captioning is deferred to the consumer — the handler stays thin.
    expect(env.AI).toBeDefined();
  });

  it('carries a user-supplied caption straight onto the job, skipping AI', async () => {
    const env = baseEnv();
    const aiSpy = vi.spyOn(env.AI, 'run');
    const form = new FormData();
    form.set('image', new File(['abc'], 'photo.jpg', { type: 'image/jpeg' }));
    form.set('caption', 'my own caption');

    const res = await req('/post', env, authedForm(form));
    expect(res.status).toBe(202);
    const job: PostJob = env.POST_QUEUE.send.mock.calls[0][0];
    expect(job.caption).toBe('my own caption');
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it('queues a carousel job with all raw keys', async () => {
    const env = baseEnv();
    const form = new FormData();
    form.append('image', new File(['a'], 'a.jpg', { type: 'image/jpeg' }));
    form.append('image', new File(['b'], 'b.png', { type: 'image/png' }));

    const res = await req('/post', env, authedForm(form));
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ status: 'processing', type: 'carousel' });

    const job: PostJob = env.POST_QUEUE.send.mock.calls[0][0];
    expect(job.type).toBe('carousel');
    expect(job.r2_keys).toHaveLength(2);
    expect(job.mime_types).toEqual(['image/jpeg', 'image/png']);
  });

  it('queues a video job (phase 1: no container_id yet)', async () => {
    const env = baseEnv();
    const form = new FormData();
    form.set(
      'image',
      new File(['video-bytes'], 'clip.mp4', { type: 'video/mp4' }),
    );

    const res = await req('/post', env, authedForm(form));
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ status: 'processing', type: 'video' });

    const job: PostJob = env.POST_QUEUE.send.mock.calls[0][0];
    expect(job.type).toBe('video');
    expect(job.r2_keys).toHaveLength(1);
    expect(job.container_id).toBeUndefined();
  });

  it('rejects mixing a video with more than one file', async () => {
    const env = baseEnv();
    const form = new FormData();
    form.append('image', new File(['v'], 'clip.mp4', { type: 'video/mp4' }));
    form.append('image', new File(['v2'], 'clip2.mp4', { type: 'video/mp4' }));

    const res = await req('/post', env, authedForm(form));
    expect(res.status).toBe(400);
  });
});

describe('queue consumer — image/carousel job', () => {
  it('publishes, acks before cleanup, and deletes both raw and processed keys on success', async () => {
    const env = baseEnv();
    await env.IMAGES.put('raw1.jpg', new Uint8Array([1, 2, 3]).buffer);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        // GET polls container status, POST creates/publishes.
        if (init?.method === 'GET')
          return new Response(
            JSON.stringify({ id: 'container_1', status_code: 'FINISHED' }),
            { status: 200 },
          );
        return new Response(JSON.stringify({ id: 'container_1' }), {
          status: 200,
        });
      }),
    );

    const msg = fakeMessage({
      type: 'image',
      r2_keys: ['raw1.jpg'],
      mime_types: ['image/jpeg'],
      caption: 'hello',
    });

    await worker.queue({ messages: [msg] } as any, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    // ack must happen before the raw key is cleaned up
    const ackOrder = msg.ack.mock.invocationCallOrder[0];
    const deleteCalls = env.IMAGES.delete.mock.invocationCallOrder;
    expect(deleteCalls.every((t: number) => t > ackOrder)).toBe(true);
    expect(env.IMAGES.delete).toHaveBeenCalledWith('raw1.jpg');

    vi.unstubAllGlobals();
  });

  it('retries and preserves the raw key when publishing fails', async () => {
    const env = baseEnv();
    await env.IMAGES.put('raw1.jpg', new Uint8Array([1, 2, 3]).buffer);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'boom' } }), {
            status: 400,
          }),
      ),
    );

    const msg = fakeMessage({
      type: 'image',
      r2_keys: ['raw1.jpg'],
      mime_types: ['image/jpeg'],
      caption: 'hello',
    });

    await worker.queue({ messages: [msg] } as any, env);

    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(env.IMAGES.store.has('raw1.jpg')).toBe(true);

    vi.unstubAllGlobals();
  });

  it('retries when the raw R2 object is missing', async () => {
    const env = baseEnv();
    const msg = fakeMessage({
      type: 'image',
      r2_keys: ['missing.jpg'],
      mime_types: ['image/jpeg'],
      caption: 'hello',
    });

    await worker.queue({ messages: [msg] } as any, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(msg.ack).not.toHaveBeenCalled();
  });
});

describe('queue consumer — video job', () => {
  it('phase 1 creates the container and chains to phase 2 without deleting R2', async () => {
    const env = baseEnv();
    await env.IMAGES.put('clip.mp4', new Uint8Array([1, 2, 3]).buffer);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: 'container_1' }), { status: 200 }),
      ),
    );

    const msg = fakeMessage({
      type: 'video',
      r2_keys: ['clip.mp4'],
      mime_types: ['video/mp4'],
      caption: 'hello',
    });

    await worker.queue({ messages: [msg] } as any, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(env.IMAGES.delete).not.toHaveBeenCalled();
    expect(env.POST_QUEUE.send).toHaveBeenCalledTimes(1);
    const phase2: PostJob = env.POST_QUEUE.send.mock.calls[0][0];
    expect(phase2.container_id).toBe('container_1');
    expect(phase2.r2_keys).toEqual(['clip.mp4']);

    vi.unstubAllGlobals();
  });

  it('phase 1 gives up (acks) and cleans up R2 when container creation fails', async () => {
    const env = baseEnv();
    await env.IMAGES.put('clip.mp4', new Uint8Array([1, 2, 3]).buffer);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'bad video' } }), {
            status: 400,
          }),
      ),
    );

    const msg = fakeMessage({
      type: 'video',
      r2_keys: ['clip.mp4'],
      mime_types: ['video/mp4'],
      caption: 'hello',
    });

    await worker.queue({ messages: [msg] } as any, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(env.IMAGES.store.has('clip.mp4')).toBe(false);
    expect(env.POST_QUEUE.send).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('phase 2 publishes and acks-then-deletes when FINISHED', async () => {
    const env = baseEnv();
    await env.IMAGES.put('clip.mp4', new Uint8Array([1, 2, 3]).buffer);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('media_publish'))
          return new Response(JSON.stringify({ id: 'post_1' }), {
            status: 200,
          });
        return new Response(
          JSON.stringify({ id: 'container_1', status_code: 'FINISHED' }),
          {
            status: 200,
          },
        );
      }),
    );

    const msg = fakeMessage({
      type: 'video',
      r2_keys: ['clip.mp4'],
      mime_types: ['video/mp4'],
      caption: 'hello',
      container_id: 'container_1',
    });

    await worker.queue({ messages: [msg] } as any, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(env.IMAGES.store.has('clip.mp4')).toBe(false);

    vi.unstubAllGlobals();
  });

  it('phase 2 retries while Instagram is still processing (IN_PROGRESS)', async () => {
    const env = baseEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ id: 'container_1', status_code: 'IN_PROGRESS' }),
            {
              status: 200,
            },
          ),
      ),
    );

    const msg = fakeMessage({
      type: 'video',
      r2_keys: ['clip.mp4'],
      mime_types: ['video/mp4'],
      caption: 'hello',
      container_id: 'container_1',
    });

    await worker.queue({ messages: [msg] } as any, env);

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(msg.ack).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('phase 2 gives up (acks) and cleans up on ERROR', async () => {
    const env = baseEnv();
    await env.IMAGES.put('clip.mp4', new Uint8Array([1, 2, 3]).buffer);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ id: 'container_1', status_code: 'ERROR' }),
            {
              status: 200,
            },
          ),
      ),
    );

    const msg = fakeMessage({
      type: 'video',
      r2_keys: ['clip.mp4'],
      mime_types: ['video/mp4'],
      caption: 'hello',
      container_id: 'container_1',
    });

    await worker.queue({ messages: [msg] } as any, env);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(env.IMAGES.store.has('clip.mp4')).toBe(false);

    vi.unstubAllGlobals();
  });
});
