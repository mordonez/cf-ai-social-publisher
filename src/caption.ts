import { Buffer } from 'node:buffer';

const DEFAULT_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const DEFAULT_CAPTION_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export type PersonaConfig = {
  describeImagePrompt: string;
  describeVideoFramePrompt: string;
  captionSystemPrompt: string;
  fallbackCaption: string;
  /** Workers AI vision model used to describe images/frames. Defaults to `@cf/meta/llama-3.2-11b-vision-instruct`. */
  visionModel?: string;
  /** Workers AI text model used to write the caption. Defaults to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. */
  captionModel?: string;
  /** Workers AI model used to transcribe a video's audio track. Defaults to `@cf/openai/gpt-4o-transcribe`. */
  transcriptionModel?: string;
};

function prepareForAI(buffer: ArrayBuffer, mimeType: string): string {
  // Buffer.from() + toString('base64') is native C++ — fast even for large images
  const base64 = Buffer.from(buffer).toString('base64');
  console.log('img_size', `${Math.round(buffer.byteLength / 1024)}KB`);
  return `data:${mimeType};base64,${base64}`;
}

async function generateCaptionFromDescription(
  description: string,
  ai: Ai,
  persona: PersonaConfig,
): Promise<string> {
  const captionRes = await (ai as any).run(
    persona.captionModel ?? DEFAULT_CAPTION_MODEL,
    {
      messages: [
        { role: 'system', content: persona.captionSystemPrompt },
        { role: 'user', content: `Description: "${description}"` },
      ],
      max_tokens: 350,
    },
  );
  return ((captionRes as any).response ?? '').trim();
}

async function describeImage(
  buffer: ArrayBuffer,
  mimeType: string,
  ai: Ai,
  prompt: string,
  model: string,
): Promise<string> {
  const dataUrl = prepareForAI(buffer, mimeType);

  const describeRes = await (ai as any).run(model, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    max_tokens: 180,
  });
  return ((describeRes as any).response ?? '').trim();
}

export async function generateCaption(
  buffer: ArrayBuffer,
  mimeType: string,
  ai: Ai,
  persona: PersonaConfig,
): Promise<string> {
  // Step 1: vision model describes the scene
  const description = await describeImage(
    buffer,
    mimeType,
    ai,
    persona.describeImagePrompt,
    persona.visionModel ?? DEFAULT_VISION_MODEL,
  );
  console.log('img_description', description);

  return generateCaptionFromDescription(description, ai, persona);
}

export async function generateCaptionFromImages(
  images: Array<{ buffer: ArrayBuffer; mimeType: string }>,
  ai: Ai,
  persona: PersonaConfig,
  audioTranscript?: string,
): Promise<string> {
  if (images.length === 0) return '';
  if (images.length === 1 && !audioTranscript)
    return generateCaption(images[0].buffer, images[0].mimeType, ai, persona);

  const visionModel = persona.visionModel ?? DEFAULT_VISION_MODEL;
  const descriptions: string[] = [];
  for (const [index, image] of images.entries()) {
    const frameDescription = await describeImage(
      image.buffer,
      image.mimeType,
      ai,
      persona.describeVideoFramePrompt,
      visionModel,
    );
    console.log('video_frame_description', index + 1, frameDescription);
    if (frameDescription)
      descriptions.push(`Frame ${index + 1}: ${frameDescription}`);
  }

  if (audioTranscript)
    descriptions.push(`Audio transcript: "${audioTranscript}"`);

  const description = descriptions.join('\n');
  console.log('video_description', description);

  return generateCaptionFromDescription(description, ai, persona);
}
