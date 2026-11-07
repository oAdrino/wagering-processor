import { describe, expect, test } from 'bun:test';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';
import { WalletBalanceChanged } from './integration-event';
import { LedgerDirection } from './wallet-ledger-entry';

const hash = 'a'.repeat(64);

describe('Inbox / Outbox', () => {
  test('Inbox é processada uma única vez', () => {
    const inbox = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'wager-processor', payloadHash: hash });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(new Date());
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(new Date())).toThrow();
  });
  test('Outbox usa backoff e não publica duas vezes', () => {
    const outbox = OutboxMessage.rehydrate({
      id: 'evt-1', aggregateId: 'wallet-1', eventType: 'WalletBalanceChanged',
      payload: {}, occurredAt: new Date(), attempts: 0,
    });
    const now = new Date();
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(now)).toBe(false);
    outbox.markPublished(new Date());
    expect(outbox.isPending()).toBe(false);
    expect(() => outbox.scheduleRetry(new Date())).toThrow();
  });
  test('Integração transporta dinheiro como string decimal', () => {
    const event = WalletBalanceChanged.fromData({
      walletId: 'wallet-1', transactionId: 'tx-1', direction: LedgerDirection.Credit,
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '10.00', currency: 'BRL' }, walletVersion: 1,
    });
    expect(event.toJSON().data.money.amount).toBe('10.00');
    expect(event.toJSON().eventType).toBe('WalletBalanceChanged');
  });
});
