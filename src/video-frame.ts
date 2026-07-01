import puppeteer from '@cloudflare/puppeteer';

export async function extractVideoFrame(videoUrl: string, browserBinding: Fetcher): Promise<ArrayBuffer | null> {
  const frames = await extractVideoFrames(videoUrl, browserBinding, 1);
  return frames[0] ?? null;
}

export async function extractVideoFrames(
  videoUrl: string,
  browserBinding: Fetcher,
  maxFrames = 3,
): Promise<ArrayBuffer[]> {
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 1280, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { margin: 0; width: 100%; height: 100%; background: #000; }
      body { display: grid; place-items: center; overflow: hidden; }
      video { max-width: 100vw; max-height: 100vh; object-fit: contain; }
    </style>
  </head>
  <body>
    <video id="video" muted playsinline preload="auto" src="${escapeHtml(videoUrl)}"></video>
  </body>
</html>`);

    const seekTimes = await page.evaluate(async (requestedFrames: number) => {
      const video = (globalThis as any).document.getElementById('video');
      if (!video) throw new Error('Video element missing');

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out loading video metadata')), 10_000);
        const fail = () => {
          clearTimeout(timeout);
          reject(new Error('Video failed to load'));
        };
        const loaded = () => {
          clearTimeout(timeout);
          resolve();
        };
        video.addEventListener('error', fail, { once: true });
        if (video.readyState >= 1) loaded();
        else video.addEventListener('loadedmetadata', loaded, { once: true });
        video.load();
      });

      if (video.readyState < 2) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out loading video frame')), 10_000);
          const done = () => {
            clearTimeout(timeout);
            resolve();
          };
          video.addEventListener('loadeddata', done, { once: true });
        });
      }

      if (!Number.isFinite(video.duration) || video.duration <= 0 || requestedFrames <= 1) {
        return [0];
      }

      if (requestedFrames === 2) {
        return [Math.min(0.5, video.duration * 0.1), Math.max(0, video.duration * 0.66)];
      }

      return [
        Math.min(0.5, video.duration * 0.1),
        video.duration * 0.5,
        Math.max(0, video.duration - 0.8),
      ];
    }, Math.max(1, Math.min(3, maxFrames)));

    const video = await page.$('#video');
    if (!video) return [];

    const frames: ArrayBuffer[] = [];
    for (const seekTo of seekTimes) {
      await page.evaluate(async (time: number) => {
        const video = (globalThis as any).document.getElementById('video');
        if (!video) throw new Error('Video element missing');

        if (time > 0) {
          video.pause();
          const target = Math.max(0, Math.min(time, Number.isFinite(video.duration) ? video.duration : time));
          if (Math.abs(video.currentTime - target) < 0.05 && video.readyState >= 2) return;

          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timed out seeking video')), 10_000);
            const done = () => {
              clearTimeout(timeout);
              resolve();
            };
            video.addEventListener('seeked', done, { once: true });
            video.currentTime = target;
          });
        }

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timed out rendering video frame')), 2_000);
          const done = () => {
            clearTimeout(timeout);
            resolve();
          };
          (globalThis as any).requestAnimationFrame(() => done());
        });
      }, seekTo);

      const frame = await video.screenshot({ type: 'jpeg', quality: 85 });
      const copy = new Uint8Array(frame.byteLength);
      copy.set(frame);
      frames.push(copy.buffer);
    }
    return frames;
  } finally {
    await browser.close();
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
