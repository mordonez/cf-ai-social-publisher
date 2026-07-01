import { Buffer } from 'node:buffer';

const DEFAULT_TRANSCRIPTION_MODEL = '@cf/openai/whisper-large-v3-turbo';

/**
 * Transcribes the audio track of a video for use as extra context when
 * writing a caption. Whisper accepts the raw video container (mp4, mov...)
 * as base64 directly — no need to demux/extract the audio track yourself.
 */
export async function transcribeVideoAudio(
  buffer: ArrayBuffer,
  ai: Ai,
  model = DEFAULT_TRANSCRIPTION_MODEL,
): Promise<string> {
  const audio = Buffer.from(buffer).toString('base64');
  const result = await (ai as any).run(model, { audio });
  return ((result as any).text ?? '').trim();
}
