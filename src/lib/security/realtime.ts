import type { Server } from 'socket.io';

export function getSocketServer(): Server | undefined {
  return (globalThis as unknown as { io?: Server }).io;
}
