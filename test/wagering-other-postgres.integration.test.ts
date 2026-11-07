import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../mikro-orm.config';
import { CreateWalletUseCase } from '../src/application/use-cases/create-wallet.use-case';
import { ProcessBetUseCase, type ProcessBetInput } from '../src/application/use-cases/process-bet.use-case';
import {
  ProcessOtherWagerUseCase,
  type ProcessOtherWagerInput,
} from '../src/application/use-cases/process-other-wager.use-case';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../src/domain/entities/wager-transaction';
import { WalletRecord } from '../src/infrastructure/database/entities/wallet.record';
import { WalletLedgerEntryRecord } from '../src/infrastructure/database/entities/wallet-ledger-entry.record';

const suite = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

suite('WIN, LOSS, REFUND, ROLLBACK — PostgreSQL real', () => {
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let bet: ProcessBetUseCase;
  let other: ProcessOtherWagerUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    createWallet = new CreateWalletUseCase(orm);
    bet = new ProcessBetUseCase(orm);
    other = new ProcessOtherWagerUseCase(orm);
  });

  afterAll(async () => { if (orm) await orm.close(); });

  const key = (body: { providerId: string; externalTransactionId: string }) =>
    `${body.providerId}:${body.externalTransactionId}`;

  async function fixture(initialBalance = '100.00'): Promise<ProcessBetInput> {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId, initialBalance: { amount: initialBalance, currency: 'BRL' },
    });
    return {
      providerId: 'provider-test', externalTransactionId: randomUUID(),
      playerId, walletId: wallet.id, roundId: randomUUID(), gameId: 'game-test',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    };
  }

  function operation(
    fixtureBet: ProcessBetInput,
    kind: ProcessOtherWagerInput['kind'],
    amount = '30.00',
    referenceExternalTransactionId?: string,
  ): ProcessOtherWagerInput {
    return {
      ...fixtureBet, externalTransactionId: randomUUID(), kind,
      money: { amount, currency: 'BRL' },
      ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
    };
  }

  async function snapshot(walletId: string) {
    const em = orm.em.fork();
    const wallet = await em.findOneOrFail(WalletRecord, { id: walletId });
    const entries = await em.count(WalletLedgerEntryRecord, { wallet: walletId });
    return { amount: wallet.balanceAmount, version: wallet.version, entries };
  }

  test('WIN credita saldo, cria ledger e replay não credita novamente', async () => {
    const base = await fixture();
    const win = operation(base, WagerTransactionKind.Win, '50.00');
    const original = await other.execute(win, key(win));
    const replay = await other.execute(win, key(win));

    expect(original.status).toBe(WagerTransactionStatus.Processed);
    expect(original.balance.amount).toBe('150.00');
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(original.transactionId);
    expect(await snapshot(base.walletId)).toEqual({ amount: '150.00', version: 2, entries: 2 });
  }, 30000);

  test('LOSS é processada sem alterar saldo, versão nem ledger', async () => {
    const base = await fixture();
    const loss = operation(base, WagerTransactionKind.Loss, '0.00');
    const result = await other.execute(loss, key(loss));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(await snapshot(base.walletId)).toEqual({ amount: '100.00', version: 1, entries: 1 });
  }, 30000);

  test('REFUND devolve uma BET e recusa segunda reversão do mesmo tipo', async () => {
    const base = await fixture();
    await bet.execute(base, key(base));
    const refund = operation(base, WagerTransactionKind.Refund, '30.00', base.externalTransactionId);
    const first = await other.execute(refund, key(refund));
    const second = operation(base, WagerTransactionKind.Refund, '30.00', base.externalTransactionId);
    const duplicate = await other.execute(second, key(second));

    expect(first.status).toBe(WagerTransactionStatus.Processed);
    expect(first.balance.amount).toBe('100.00');
    expect(duplicate.status).toBe(WagerTransactionStatus.Rejected);
    expect(duplicate.failureCode).toBe(FailureCode.DuplicateReversal);
    expect(await snapshot(base.walletId)).toEqual({ amount: '100.00', version: 3, entries: 3 });
  }, 30000);

  test('ROLLBACK de REFUND debita; não permite ultrapassar saldo', async () => {
    const base = await fixture();
    await bet.execute(base, key(base));
    const refund = operation(base, WagerTransactionKind.Refund, '30.00', base.externalTransactionId);
    await other.execute(refund, key(refund));
    const rollback = operation(base, WagerTransactionKind.Rollback, '30.00', refund.externalTransactionId);
    const result = await other.execute(rollback, key(rollback));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(await snapshot(base.walletId)).toEqual({ amount: '70.00', version: 4, entries: 4 });
  }, 30000);

  test('ROLLBACK de WIN com saldo insuficiente é rejeitado com código próprio', async () => {
    const base = await fixture('0.00');
    const win = operation(base, WagerTransactionKind.Win, '60.00');
    await other.execute(win, key(win));
    const spendingBet: ProcessBetInput = {
      ...base, externalTransactionId: randomUUID(), money: { amount: '50.00', currency: 'BRL' },
    };
    await bet.execute(spendingBet, key(spendingBet));
    const rollback = operation(base, WagerTransactionKind.Rollback, '60.00', win.externalTransactionId);
    const result = await other.execute(rollback, key(rollback));

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(await snapshot(base.walletId)).toEqual({ amount: '10.00', version: 3, entries: 2 });
  }, 30000);

  test('REFUND antes da BET permanece PENDING_REFERENCE, sem movimentar saldo', async () => {
    const base = await fixture();
    const refund = operation(base, WagerTransactionKind.Refund, '30.00', base.externalTransactionId);
    const pending = await other.execute(refund, key(refund));
    const replay = await other.execute(refund, key(refund));

    expect(pending.status).toBe(WagerTransactionStatus.PendingReference);
    expect(replay.idempotentReplay).toBe(true);
    expect(await snapshot(base.walletId)).toEqual({ amount: '100.00', version: 1, entries: 1 });
  }, 30000);

  test('REFUND com valor diferente da BET é REJECTED sem crédito', async () => {
    const base = await fixture();
    await bet.execute(base, key(base));
    const refund = operation(base, WagerTransactionKind.Refund, '20.00', base.externalTransactionId);
    const result = await other.execute(refund, key(refund));

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    expect(await snapshot(base.walletId)).toEqual({ amount: '70.00', version: 2, entries: 2 });
  }, 30000);

  test('duas reversões em paralelo só aplicam um crédito', async () => {
    const base = await fixture();
    await bet.execute(base, key(base));
    const a = operation(base, WagerTransactionKind.Refund, '30.00', base.externalTransactionId);
    const b = operation(base, WagerTransactionKind.Refund, '30.00', base.externalTransactionId);
    const [r1, r2] = await Promise.all([other.execute(a, key(a)), other.execute(b, key(b))]);

    expect([r1.status, r2.status].filter((s) => s === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect([r1.status, r2.status].filter((s) => s === WagerTransactionStatus.Rejected)).toHaveLength(1);
    expect(await snapshot(base.walletId)).toEqual({ amount: '100.00', version: 3, entries: 3 });
  }, 30000);
});
