import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import { messageStatus } from '../../src/modules/whatsapp/message-status';
test('receipt mapping only reports delivery and reading after the corresponding protocol ACK', () => {
  const S = proto.WebMessageInfo.Status;
  assert.equal(messageStatus(S.ERROR), 'FAILED');
  assert.equal(messageStatus(S.PENDING), 'PENDING');
  assert.equal(messageStatus(S.SERVER_ACK), 'SENT');
  assert.equal(messageStatus(S.DELIVERY_ACK), 'DELIVERED');
  assert.equal(messageStatus(S.READ), 'READ');
  assert.equal(messageStatus(S.PLAYED), 'READ');
  assert.equal(messageStatus(undefined), null);
  assert.equal(messageStatus(99), null);
});
