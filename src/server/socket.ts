import { Server, Socket } from 'socket.io';
import { getToken } from 'next-auth/jwt';
import { prisma } from '../lib/prisma';
import { hashApiKey } from '../lib/security/secrets';
import { canAccessDatabaseSession, resolveSession } from '../lib/security/session-access';

type Identity = { id: string; role: string; expiresAt: number; keyHash?: string };
export async function authenticateSocket(socket: Socket): Promise<Identity | null> {
  const headerKey = socket.handshake.headers['x-api-key'];
  const apiKey = socket.handshake.auth?.apiKey ?? headerKey;
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || apiKey.length > 256) return null;
    const keyHash = hashApiKey(apiKey);
    const user = await prisma.user.findUnique({ where: { apiKey: keyHash, disabled: false }, select: { id: true, role: true } });
    return user ? { ...user, keyHash, expiresAt: Date.now() + 24 * 3600_000 } : null;
  }
  const token = await getToken({ req: { headers: socket.handshake.headers as Record<string, string> }, secret: process.env.AUTH_SECRET!, secureCookie: process.env.BASE_URL?.startsWith('https://') });
  if (!token || typeof token.id !== 'string' || typeof token.exp !== 'number' || token.exp * 1000 <= Date.now()) return null;
  const user = await prisma.user.findUnique({ where: { id: token.id, disabled: false }, select: { id: true, role: true } });
  return user ? { ...user, expiresAt: token.exp * 1000 } : null;
}

export function setupSocket(io: Server) {
  io.use(async (socket, next) => {
    try {
      const identity = await authenticateSocket(socket);
      if (!identity) return next(new Error('Unauthorized'));
      socket.data.identity = identity;
      next();
    } catch { next(new Error('Unauthorized')); }
  });

  io.on('connection', socket => {
    socket.join(`user:${socket.data.identity.id}`);
    socket.on('join-user-room', () => {});
    socket.on('join-session', async (identifier: unknown, ack?: (result: { allowed: boolean }) => void) => {
      const answer = (allowed: boolean) => { if (typeof ack === 'function') ack({ allowed }); };
      try {
        if (typeof identifier !== 'string' || identifier.length > 160) { answer(false); return; }
        const identity = await authenticateSocket(socket);
        if (!identity) { answer(false); return; }
        const session = await resolveSession(identifier);
        if (session && await canAccessDatabaseSession(identity.id, identity.role, session.id)) {
          await socket.join(`session:${session.id}`);
          answer(true);
        } else answer(false);
      } catch { answer(false); socket.disconnect(true); }
    });
    const interval = setInterval(async () => {
      try {
        const identity = await authenticateSocket(socket);
        if (!identity) { socket.disconnect(true); return; }
        for (const room of socket.rooms) {
          if (room === socket.id || room === `user:${identity.id}`) continue;
          if (!room.startsWith("session:") || !await canAccessDatabaseSession(identity.id, identity.role, room.slice(8))) await socket.leave(room);
        }
      } catch { socket.disconnect(true); }
    }, 5_000);
    interval.unref();
    socket.on('disconnect', () => clearInterval(interval));
  });
}
