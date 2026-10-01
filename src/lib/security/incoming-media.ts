import { getMediaKeys, normalizeMessageContent, WAMessage, MediaType } from '@whiskeysockets/baileys';
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { safeFetch } from './safe-fetch';

export async function decryptWhatsAppMedia(bytes: Buffer, mediaKey: Uint8Array, type: string): Promise<Buffer> {
  if (!['image', 'video', 'audio', 'document', 'sticker'].includes(type)) throw new Error('Unsupported media type');
  if (mediaKey.length !== 32 || bytes.length < 26 || bytes.length > 10 * 1024 * 1024) throw new Error('Invalid encrypted media');
  const { iv, cipherKey, macKey } = await getMediaKeys(Buffer.from(mediaKey), type as MediaType);
  if (!macKey) throw new Error("Missing media authentication key");
  const ciphertext = bytes.subarray(0, -10);
  const expected = createHmac('sha256', macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
  if (!timingSafeEqual(expected, bytes.subarray(-10))) throw new Error('Invalid media authentication tag');
  const cipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([cipher.update(ciphertext), cipher.final()]);
}

export async function downloadSafeMedia(message: WAMessage): Promise<Buffer> {
  const content = normalizeMessageContent(message.message);
  const entry = content && Object.entries(content).find(([type]) => ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type));
  if (!entry || !entry[1]) throw new Error('No downloadable media');
  const media = entry[1] as { url?: string; directPath?: string; thumbnailDirectPath?: string; mediaKey?: Uint8Array; fileSha256?: Uint8Array; fileEncSha256?: Uint8Array };
  const directPath = media.directPath || media.thumbnailDirectPath;
  if (directPath && (!directPath.startsWith('/') || directPath.startsWith('//') || directPath.includes('\\'))) throw new Error('Invalid direct media path');
  const url = directPath ? `https://mmg.whatsapp.net${directPath}` : media.url;
  if (!url) throw new Error('Missing media URL');
  const response = await safeFetch(url);
  if (!response.ok) throw new Error('Media download failed');
  const encrypted = Buffer.from(await response.arrayBuffer());
  if (media.fileEncSha256 && !Buffer.from(media.fileEncSha256).equals(createHash('sha256').update(encrypted).digest())) throw new Error('Encrypted media hash mismatch');
  const bytes = media.mediaKey ? await decryptWhatsAppMedia(encrypted, media.mediaKey, entry[0].replace('Message', '')) : encrypted;
  if (media.fileSha256 && !Buffer.from(media.fileSha256).equals(createHash('sha256').update(bytes).digest())) throw new Error('Media hash mismatch');
  return bytes;
}
