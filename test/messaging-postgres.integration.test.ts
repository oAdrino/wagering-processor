import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';
import { CreateWalletUseCase } from '../src/application/use-cases/create-wallet.use-case';
import { ProcessBetUseCase, type ProcessBetInput } from '../src/application/use-cases/process-bet.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../src/domain/entities/wager-transaction';

const suite = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

suite('Inbox/Outbox no PostgreSQL real', () => {
  let orm: MikroORM;
  let wallets: CreateWalletUseCase;
  let bet: ProcessBetUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    wallets = new CreateWalletUseCase(orm);
    bet = new ProcessBetUseCase(orm);
  });
  afterAll(async () => { if (orm) await orm.close(); });

  async function fixture(): Promise<ProcessBetInput> {
    const playerId = randomUUID();
    const w = await wallets.execute({
      playerId, initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    return {
      providerId: 'provider-messaging', playerId, walletId: w.id,
      externalTransactionId: randomUUID(), roundId: randomUUID(), gameId: 'test',
      kind: WagerTransactionKind.Bet, money: { amount: '25.00', currency: 'BRL' },
    };
  }

  test('Wallet OPENING e ledger geram dois eventos Outbox no mesmo commit', async () => {
    const playerId = randomUUID();
    const w = await wallets.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const rows = await orm.em.fork().getConnection().execute<{
      event_type: string; payload: { data: Record<string, unknown> };
    }[]>(`
      select o.event_type, o.payload from outbox_messages o
      join wager_transactions t on o.aggregate_id = t.id
      where t.wallet_id = ? and t.kind = 'OPENING'
      order by o.event_type
    `, [w.id]);
    expect(rows.map((r) => r.event_type)).toEqual([
      'WagerTransactionProcessed', 'WalletBalanceChanged',
    ]);
    const changed = rows.find((r) => r.event_type === 'WalletBalanceChanged');
    expect((changed?.payload.data.money as { amount: string }).amount).toBe('100.00');
    expect(changed?.payload.data.walletVersion).toBe(1);
  }, 30000);

  test('Inbox e débito são atômicos; redelivery não duplica ledger', async () => {
    const request = await fixture();
    const idempotencyKey = `${request.providerId}:${request.externalTransactionId}`;
    const receipt = {
      consumerName: 'wager-processor', messageId: randomUUID(),
      payloadHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    };
    const first = await bet.execute(request, idempotencyKey, receipt);
    const replay = await bet.execute(request, idempotencyKey, receipt);
    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.idempotentReplay).toBe(true);
    const rows = await orm.em.fork().getConnection().execute<{ count: string }[]>(`
      select count(*)::text as count from inbox_messages
      where consumer_name = ? and message_id = ?
    `, [receipt.consumerName, receipt.messageId]);
    expect(rows[0].count).toBe('1');
    const ledger = await orm.em.fork().getConnection().execute<{ count: string }[]>(`
      select count(*)::text as count from wallet_ledger_entries
      where transaction_id = ?
    `, [first.transactionId]);
    expect(ledger[0].count).toBe('1');
  }, 30000);

  test('messageId com outro payload é rejeitado e não debita', async () => {
    const request = await fixture();
    const key = `${request.providerId}:${request.externalTransactionId}`;
    const messageId = randomUUID();
    const receipt = {
      consumerName: 'wager-processor', messageId, payloadHash: 'a'.repeat(64),
    };
    await bet.execute(request, key, receipt);
    const second: ProcessBetInput = { ...request, externalTransactionId: randomUUID() };
    await expect(bet.execute(second, `${second.providerId}:${second.externalTransactionId}`,
      { ...receipt, payloadHash: 'b'.repeat(64) })).rejects.toThrow();
    const rows = await orm.em.fork().getConnection().execute<{ count: string }[]>(`
      select count(*)::text as count from wallet_ledger_entries
      where wallet_id = ? and direction = 'DEBIT'
    `, [request.walletId]);
    expect(rows[0].count).toBe('1');
  }, 30000);
});
