import type { Server } from 'socket.io';
import type { Socket } from 'socket.io-client';
declare global {
  var io: Server | undefined;
  interface Window { __socket?: Socket; }
}
export { };
