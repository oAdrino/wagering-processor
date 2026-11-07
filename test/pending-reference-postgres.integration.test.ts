import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import config from '../mikro-orm.config';
import { CreateWalletUseCase } from '../src/application/use-cases/create-wallet.use-case';
import { ProcessBetUseCase, type ProcessBetInput } from '../src/application/use-cases/process-bet.use-case';
import { ProcessOtherWagerUseCase, type ProcessOtherWagerInput } from '../src/application/use-cases/process-other-wager.use-case';
import { PendingReferenceWorker } from '../src/application/workers/pending-reference.worker';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../src/domain/entities/wager-transaction';
import { WalletRecord } from '../src/infrastructure/database/entities/wallet.record';
import { WagerTransactionRecord } from '../src/infrastructure/database/entities/wager-transaction.record';
import { WalletLedgerEntryRecord } from '../src/infrastructure/database/entities/wallet-ledger-entry.record';

const suite = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

suite('Worker de referências pendentes — PostgreSQL real', () => {
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let bet: ProcessBetUseCase;
  let other: ProcessOtherWagerUseCase;
  let worker: PendingReferenceWorker;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    createWallet = new CreateWalletUseCase(orm);
    bet = new ProcessBetUseCase(orm);
    other = new ProcessOtherWagerUseCase(orm);
    worker = new PendingReferenceWorker(orm);
  });

  afterAll(async () => {
    if (orm) await orm.close();
  });

  function key(data: { providerId: string; externalTransactionId: string }): string {
    return `${data.providerId}:${data.externalTransactionId}`;
  }

  async function fixture(initialBalance = '100.00'): Promise<ProcessBetInput> {
    const playerId = randomUUID();
    const result = await createWallet.execute({
      playerId,
      initialBalance: { amount: initialBalance, currency: 'BRL' },
    });
    return {
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: result.id,
      roundId: randomUUID(),
      gameId: 'game-test',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    };
  }

  function operation(
    base: ProcessBetInput,
    kind: ProcessOtherWagerInput['kind'],
    amount: string,
    referenceExternalTransactionId?: string,
  ): ProcessOtherWagerInput {
    return {
      ...base,
      externalTransactionId: randomUUID(),
      kind,
      money: { amount, currency: 'BRL' },
      ...(referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId } : {}),
    };
  }

  async function forceDue(transactionId: string, attempts?: number): Promise<void> {
    const em = orm.em.fork();
    const record = await em.findOneOrFail(WagerTransactionRecord, { id: transactionId });
    record.nextAttemptAt = new Date('2000-01-01T00:00:00Z');
    if (attempts !== undefined) record.attempts = attempts;
    await em.flush();
  }

  async function snapshot(walletId: string) {
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: walletId });
    const entries = await em.count(WalletLedgerEntryRecord, { wallet: walletId });
    return { balance: wallet.balanceAmount, version: wallet.version, entries };
  }

  test('REFUND recebido antes da BET é processado quando a referência chega', async () => {
    const base = await fixture();
    const refund = operation(base, WagerTransactionKind.Refund, '30.00', base.externalTransactionId);
    const pending = await other.execute(refund, key(refund));
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    await bet.execute(base, key(base));
    await forceDue(pending.transactionId);
    await worker.runOnce();

    const current = await orm.em.fork().findOneOrFail(WagerTransactionRecord, { id: pending.transactionId });
    expect(current.status).toBe(WagerTransactionStatus.Processed);
    expect(await snapshot(base.walletId)).toEqual({ balance: '100.00', version: 3, entries: 3 });

    const replay = await other.execute(refund, key(refund));
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.balance.amount).toBe('100.00');
  }, 30000);

  test('referência ausente é reprogramada, depois rejeitada no limite', async () => {
    const base = await fixture();
    const refund = operation(base, WagerTransactionKind.Refund, '30.00', base.externalTransactionId);
    const pending = await other.execute(refund, key(refund));

    await forceDue(pending.transactionId);
    await worker.runOnce();
    let record = await orm.em.fork().findOneOrFail(WagerTransactionRecord, { id: pending.transactionId });
    expect(record.status).toBe(WagerTransactionStatus.PendingReference);
    expect(record.attempts).toBe(1);
    expect(record.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    await forceDue(pending.transactionId, 7);
    await worker.runOnce();
    record = await orm.em.fork().findOneOrFail(WagerTransactionRecord, { id: pending.transactionId });
    expect(record.status).toBe(WagerTransactionStatus.Rejected);
    expect(record.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(await snapshot(base.walletId)).toEqual({ balance: '100.00', version: 1, entries: 1 });
  }, 30000);

  test('ROLLBACK pendente é rejeitado se causar saldo negativo', async () => {
    const base = await fixture('0.00');
    const win = operation(base, WagerTransactionKind.Win, '60.00');
    const rollback = operation(base, WagerTransactionKind.Rollback, '60.00', win.externalTransactionId);
    const pending = await other.execute(rollback, key(rollback));
    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);

    await other.execute(win, key(win));
    await bet.execute({ ...base, money: { amount: '50.00', currency: 'BRL' } }, key(base));

    await forceDue(pending.transactionId);
    await worker.runOnce();
    const record = await orm.em.fork().findOneOrFail(WagerTransactionRecord, { id: pending.transactionId });
    expect(record.status).toBe(WagerTransactionStatus.Rejected);
    expect(record.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(await snapshot(base.walletId)).toEqual({ balance: '10.00', version: 3, entries: 2 });
  }, 30000);

  test('dois workers simultâneos não duplicam a reversão', async () => {
    const base = await fixture();
    const refund = operation(base, WagerTransactionKind.Refund, '30.00', base.externalTransactionId);
    const pending = await other.execute(refund, key(refund));
    await bet.execute(base, key(base));
    await forceDue(pending.transactionId);

    const worker2 = new PendingReferenceWorker(orm);
    await Promise.all([worker.runOnce(), worker2.runOnce()]);

    const record = await orm.em.fork().findOneOrFail(WagerTransactionRecord, { id: pending.transactionId });
    expect(record.status).toBe(WagerTransactionStatus.Processed);
    expect(await snapshot(base.walletId)).toEqual({ balance: '100.00', version: 3, entries: 3 });
  }, 30000);
});
