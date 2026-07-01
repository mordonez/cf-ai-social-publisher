const BASE = 'https://graph.facebook.com/v21.0';

type StatusCode =
  'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED' | 'ERROR' | 'EXPIRED';

async function graphRequest<T>(
  url: URL,
  method: 'GET' | 'POST' = 'GET',
  accessToken?: string,
): Promise<T> {
  const headers: HeadersInit = accessToken
    ? { Authorization: `Bearer ${accessToken}` }
    : {};
  const res = await fetch(url.toString(), { method, headers });
  const data = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok || (data as { error?: { message: string } }).error) {
    throw new Error(
      (data as { error?: { message: string } }).error?.message ??
        `HTTP ${res.status}`,
    );
  }
  return data;
}

async function createMediaContainer(
  accountId: string,
  accessToken: string,
  imageUrl: string,
  caption: string,
): Promise<string> {
  const url = new URL(`${BASE}/${accountId}/media`);
  url.searchParams.set('image_url', imageUrl);
  url.searchParams.set('caption', caption);

  const data = await graphRequest<{ id: string }>(url, 'POST', accessToken);
  return data.id;
}

async function waitForContainer(
  containerId: string,
  accessToken: string,
  maxAttempts = 3,
  delayMs = 2000,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const url = new URL(`${BASE}/${containerId}`);
    url.searchParams.set('fields', 'status_code');

    const data = await graphRequest<{ id: string; status_code: StatusCode }>(
      url,
      'GET',
      accessToken,
    );

    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      throw new Error(`Media container failed: ${data.status_code}`);
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error('Media container timed out waiting to be ready');
}

async function publishMedia(
  accountId: string,
  accessToken: string,
  containerId: string,
): Promise<string> {
  const url = new URL(`${BASE}/${accountId}/media_publish`);
  url.searchParams.set('creation_id', containerId);

  const data = await graphRequest<{ id: string }>(url, 'POST', accessToken);
  return data.id;
}

export async function publishToInstagram(
  accountId: string,
  accessToken: string,
  imageUrl: string,
  caption: string,
): Promise<string> {
  const containerId = await createMediaContainer(
    accountId,
    accessToken,
    imageUrl,
    caption,
  );
  await waitForContainer(containerId, accessToken);
  return publishMedia(accountId, accessToken, containerId);
}

export async function createVideoContainer(
  accountId: string,
  accessToken: string,
  videoUrl: string,
  caption: string,
): Promise<string> {
  const url = new URL(`${BASE}/${accountId}/media`);
  url.searchParams.set('media_type', 'REELS');
  url.searchParams.set('video_url', videoUrl);
  url.searchParams.set('caption', caption);

  const data = await graphRequest<{ id: string }>(url, 'POST', accessToken);
  return data.id;
}

export async function checkContainerStatus(
  containerId: string,
  accessToken: string,
): Promise<StatusCode> {
  const url = new URL(`${BASE}/${containerId}`);
  url.searchParams.set('fields', 'status_code');

  const data = await graphRequest<{ id: string; status_code: StatusCode }>(
    url,
    'GET',
    accessToken,
  );
  return data.status_code;
}

export async function publishFromContainer(
  accountId: string,
  accessToken: string,
  containerId: string,
): Promise<string> {
  return publishMedia(accountId, accessToken, containerId);
}
