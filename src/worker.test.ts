import { describe, it, expect } from 'vitest';
import { createInstagramWorker } from './worker';
import type { PersonaConfig } from './caption';

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

const env = { API_KEY: 'secret' } as any;

function req(path: string, init?: RequestInit) {
  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    env,
    {} as any,
  );
}

describe('GET /health', () => {
  it('is public — no auth required', async () => {
    const res = await req('/health');
    expect(res.status).toBe(200);
  });
});

describe('auth middleware', () => {
  it('blocks requests with no token', async () => {
    const res = await req('/caption', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('blocks requests with wrong token', async () => {
    const res = await req('/caption', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('passes auth with correct token', async () => {
    const res = await req('/caption', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(res.status).not.toBe(401); // 400 (missing form data) but auth passed
  });
});
