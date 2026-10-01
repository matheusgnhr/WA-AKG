import type { MessageStatus } from '@prisma/client';
import { proto } from '@whiskeysockets/baileys';
/** Baileys status values are protocol enums, never UI array indices. */
export function messageStatus(code: number | null | undefined): MessageStatus | null {
  switch (code) {
    case proto.WebMessageInfo.Status.ERROR: return 'FAILED';
    case proto.WebMessageInfo.Status.SERVER_ACK: return 'SENT';
    case proto.WebMessageInfo.Status.DELIVERY_ACK: return 'DELIVERED';
    case proto.WebMessageInfo.Status.READ:
    case proto.WebMessageInfo.Status.PLAYED: return 'READ';
    case proto.WebMessageInfo.Status.PENDING: return 'PENDING';
    default: return null;
  }
}

/** Atomic update predicates preserve confirmed delivery/reading under late ACKs. */
export function statusPredecessors(status: MessageStatus): MessageStatus[] {
  const statuses: Record<MessageStatus, MessageStatus[]> = {
    PENDING: ['PENDING'], SENT: ['PENDING', 'SENT', 'FAILED'],
    DELIVERED: ['PENDING', 'SENT', 'DELIVERED', 'FAILED'],
    READ: ['PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED'], FAILED: ['PENDING', 'SENT', 'FAILED'],
  };
  return statuses[status];
}
