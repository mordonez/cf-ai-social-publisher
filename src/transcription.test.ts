import { describe, it, expect } from 'vitest';
import { transcribeVideoAudio } from './transcription';

describe('transcribeVideoAudio', () => {
  it('returns the transcribed text from the AI response', async () => {
    const mockAi = {
      run: async (model: string, input: any) => {
        expect(model).toBe('@cf/openai/whisper-large-v3-turbo');
        expect(typeof input.audio).toBe('string');
        return { text: 'Hello from the video.' };
      },
    } as unknown as Ai;

    const buffer = new Uint8Array([0x00, 0x01, 0x02]).buffer;
    const transcript = await transcribeVideoAudio(buffer, mockAi);
    expect(transcript).toBe('Hello from the video.');
  });

  it('returns an empty string when the AI response has no text', async () => {
    const mockAi = { run: async () => ({}) } as unknown as Ai;
    const buffer = new Uint8Array([0x00, 0x01, 0x02]).buffer;
    const transcript = await transcribeVideoAudio(buffer, mockAi);
    expect(transcript).toBe('');
  });

  it('uses a custom model when provided', async () => {
    const mockAi = {
      run: async (model: string) => {
        expect(model).toBe('@cf/openai/gpt-4o-transcribe');
        return { text: 'custom model transcript' };
      },
    } as unknown as Ai;

    const buffer = new Uint8Array([0x00, 0x01, 0x02]).buffer;
    const transcript = await transcribeVideoAudio(
      buffer,
      mockAi,
      '@cf/openai/gpt-4o-transcribe',
    );
    expect(transcript).toBe('custom model transcript');
  });
});
