import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { parseMediaFilename } from './identifiers';

export const MEDIA_DIR = path.resolve(process.cwd(), 'data', 'media');

async function mediaPath(filename: string): Promise<string> {
  if (!parseMediaFilename(filename)) throw new Error('Invalid media filename');
  await mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
  const dir = await lstat(MEDIA_DIR);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Unsafe media directory');
  const target = path.resolve(MEDIA_DIR, filename);
  if (path.dirname(target) !== MEDIA_DIR) throw new Error('Media path escapes directory');
  return target;
}

export async function writePrivateMedia(filename: string, bytes: Buffer): Promise<void> {
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Media exceeds size limit');
  const target = await mediaPath(filename);
  const temporary = path.join(MEDIA_DIR, `.partial_${randomBytes(24).toString('hex')}`);
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, target); }
    catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe existing media file');
      // A duplicate provider event is idempotent only when it repeats identical bytes.
      if (!(await readPrivateMedia(filename)).equals(bytes)) throw new Error('Conflicting media event');
    }
  } finally { await unlink(temporary).catch(() => {}); }

}

export async function readPrivateMedia(filename: string): Promise<Buffer> {
  const file = await open(await mediaPath(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('Invalid media file');
    return await file.readFile();
  } finally { await file.close(); }
}

export async function deletePrivateMedia(filename: string): Promise<void> {
  const target = await mediaPath(filename);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid media file');
  await unlink(target);
}
