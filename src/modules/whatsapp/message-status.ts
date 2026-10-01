import type { MessageStatus } from '@prisma/client';
import { proto } from '@whiskeysockets/baileys';
/** Baileys status values are protocol enums, never UI array indices. */
export function messageStatus(code: number | null | undefined): MessageStatus {
  switch (code) {
    case proto.WebMessageInfo.Status.ERROR: return 'FAILED';
    case proto.WebMessageInfo.Status.SERVER_ACK: return 'SENT';
    case proto.WebMessageInfo.Status.DELIVERY_ACK: return 'DELIVERED';
    case proto.WebMessageInfo.Status.READ:
    case proto.WebMessageInfo.Status.PLAYED: return 'READ';
    default: return 'PENDING';
  }
}
