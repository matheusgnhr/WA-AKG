import { randomBytes } from 'node:crypto';

export function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/.test(value)) {
    throw new Error('Invalid session identifier');
  }
}

export function newSessionId(): string {
  return `wa_${randomBytes(24).toString('hex')}`;
}

export function mediaFilename(sessionId: string, messageId: unknown, type: string): string {
  assertSessionId(sessionId);
  if (typeof messageId !== 'string' || !/^[A-Za-z0-9_]{1,160}$/.test(messageId)) {
    throw new Error('Invalid media message identifier');
  }
  const extensions: Record<string, string> = {
    imageMessage: 'jpg', videoMessage: 'mp4', audioMessage: 'ogg',
    documentMessage: 'bin', stickerMessage: 'webp',
  };
  return `${sessionId}-${messageId}.${extensions[type] || 'bin'}`;
}

export function parseMediaFilename(filename: unknown): { sessionId: string; messageId: string } | null {
  if (typeof filename !== 'string') return null;
  const match = /^([A-Za-z0-9_][A-Za-z0-9_-]{0,79})-([A-Za-z0-9_]{1,160})\.(jpg|jpeg|png|gif|webp|mp4|mp3|wav|ogg|opus|m4a|pdf|bin)$/.exec(filename);
  return match ? { sessionId: match[1], messageId: match[2] } : null;
}
