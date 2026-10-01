import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type Options = { pack?: string; author?: string; quality?: number; type?: string; categories?: string[]; background?: string };
const run = promisify(execFile);

export function addStickerMetadata(webp: Buffer, width: number, height: number, options: Options): Buffer {
  if (webp.toString('ascii', 0, 4) !== 'RIFF' || webp.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Invalid WebP output');
  const chunks: Buffer[] = [];
  let hasExtended = false;
  for (let offset = 12; offset + 8 <= webp.length;) {
    const length = webp.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > webp.length) throw new Error('Invalid WebP chunk');
    const chunk = Buffer.from(webp.subarray(offset, end));
    const kind = chunk.toString('ascii', 0, 4);
    if (kind === 'VP8X') { chunk[8] |= 0x08; hasExtended = true; }
    if (kind !== 'EXIF') chunks.push(chunk);
    offset = end;
  }
  if (!hasExtended) {
    const extended = Buffer.alloc(18);
    extended.write('VP8X', 0); extended.writeUInt32LE(10, 4); extended[8] = 0x08;
    extended.writeUIntLE(width - 1, 12, 3); extended.writeUIntLE(height - 1, 15, 3);
    chunks.unshift(extended);
  }
  const json = Buffer.from(JSON.stringify({ 'sticker-pack-id': randomUUID(), 'sticker-pack-name': (options.pack || '').slice(0, 128), 'sticker-pack-publisher': (options.author || '').slice(0, 128), emojis: (options.categories || []).slice(0, 8) }));
  const tiff = Buffer.from([0x49,0x49,0x2a,0,8,0,0,0,1,0,0x41,0x57,7,0,0,0,0,0,0x16,0,0,0]);
  tiff.writeUInt32LE(json.length, 14);
  const payload = Buffer.concat([tiff, json]);
  const exif = Buffer.alloc(8 + payload.length + payload.length % 2);
  exif.write('EXIF', 0); exif.writeUInt32LE(payload.length, 4); payload.copy(exif, 8); chunks.push(exif);
  const result = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'binary'), ...chunks]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

export default class Sticker {
  constructor(private input: Buffer, private options: Options = {}) {}
  async toBuffer(): Promise<Buffer> {
    if (!Buffer.isBuffer(this.input) || this.input.length > 10 * 1024 * 1024) throw new Error('Sticker input exceeds limit');
    let input = this.input;
    let directory: string | undefined;
    try {
      if (input.toString('ascii', 4, 8) === 'ftyp') {
        directory = await mkdtemp(path.join(tmpdir(), 'wa-sticker-'));
        const source = path.join(directory, 'input.mp4');
        const target = path.join(directory, 'output.webp');
        await writeFile(source, input, { mode: 0o600 });
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-i', source, '-t', '6', '-vf', 'fps=10,scale=512:512:force_original_aspect_ratio=decrease', '-loop', '0', '-an', '-c:v', 'libwebp', target], { timeout: 10_000, maxBuffer: 64 * 1024 });
        input = await readFile(target);
      }
      const quality = Math.max(1, Math.min(100, Number.isFinite(this.options.quality) ? this.options.quality! : 50));
      const image = sharp(input, { limitInputPixels: 16_000_000, animated: true });
      const metadata = await image.metadata();
      if ((metadata.pages || 1) > 60) throw new Error('Sticker has too many frames');
      image.resize(512, 512, { fit: ['crop', 'circle'].includes(this.options.type || '') ? 'cover' : 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } });
      if (this.options.type === 'circle') {
        const mask = Buffer.from('<svg width="512" height="512"><circle cx="256" cy="256" r="256" fill="white"/></svg>');
        image.composite([{ input: mask, tile: true, blend: 'dest-in' }]);
      }
      const { data, info } = await image.webp({ quality, effort: 2 }).toBuffer({ resolveWithObject: true });
      const result = addStickerMetadata(data, info.width, metadata.pages ? info.height / metadata.pages : info.height, this.options);
      if (result.length > 1024 * 1024) throw new Error('Sticker output exceeds 1 MiB');
      return result;
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
}
