import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ConflictException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

import mikroOrmConfig from '../mikro-orm.config';
import { CreateWalletUseCase } from '../src/application/use-cases/create-wallet.use-case';
import { ProcessBetUseCase, type ProcessBetInput } from '../src/application/use-cases/process-bet.use-case';
import { WagerTransactionKind, WagerTransactionStatus, FailureCode, } from '../src/domain/entities/wager-transaction';
import { LedgerDirection } from '../src/domain/entities/wallet-ledger-entry';
import { WalletRecord } from '../src/infrastructure/database/entities/wallet.record';
import { WalletLedgerEntryRecord } from '../src/infrastructure/database/entities/wallet-ledger-entry.record';

// Os testes usam PostgreSQL REAL, com migrations já aplicadas.
// Não rodam no `bun test` comum; precisam de RUN_DB_TESTS=1.
const suite = process.env.RUN_DB_TESTS === '1' ? describe : describe.skip;

suite('BET - integração com PostgreSQL real', () => {
  let orm: MikroORM;
  let createWallet: CreateWalletUseCase;
  let processBet: ProcessBetUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(mikroOrmConfig);
    createWallet = new CreateWalletUseCase(orm);
    processBet = new ProcessBetUseCase(orm);
  });

  afterAll(async () => {
    if (orm) await orm.close();
  });

  async function fixture(initialBalance = '100.00'): Promise<ProcessBetInput> {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: initialBalance, currency: 'BRL' },
    });
    return {
      providerId: 'provider-test',
      externalTransactionId: randomUUID(),
      playerId,
      walletId: wallet.id,
      roundId: randomUUID(),
      gameId: 'test-game',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    };
  }

  async function walletBalance(walletId: string): Promise<string> {
    const wallet = await orm.em.fork().findOneOrFail(WalletRecord, { id: walletId });
    return wallet.balanceAmount;
  }

  async function debitEntries(walletId: string): Promise<number> {
    return orm.em.fork().count(WalletLedgerEntryRecord, {
      wallet: walletId,
      direction: LedgerDirection.Debit,
    });
  }

  test('50 solicitações idênticas em paralelo resultam em um débito', async () => {
    const body = await fixture();
    const key = `${body.providerId}:${body.externalTransactionId}`;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => processBet.execute(body, key)),
    );

    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.balance.amount === '70.00')).toBe(true);
    expect(await walletBalance(body.walletId)).toBe('70.00');
    expect(await debitEntries(body.walletId)).toBe(1);
  }, 30000);

  test('apostas concorrentes de 80 gastam o saldo apenas uma vez', async () => {
    const baseline = await fixture();
    const a = { ...baseline, money: { amount: '80.00', currency: 'BRL' } };
    const b = { ...a, externalTransactionId: randomUUID() };

    const results = await Promise.all([
      processBet.execute(a, `${a.providerId}:${a.externalTransactionId}`),
      processBet.execute(b, `${b.providerId}:${b.externalTransactionId}`),
    ]);

    expect(results.filter((r) => r.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(results.filter((r) => r.status === WagerTransactionStatus.Rejected)).toHaveLength(1);
    expect(await walletBalance(a.walletId)).toBe('20.00');
    expect(await debitEntries(a.walletId)).toBe(1);

    // Novo processamento deve devolver a resposta original, sem mudar o saldo.
    const replay = await processBet.execute(a, `${a.providerId}:${a.externalTransactionId}`);
    expect(replay.idempotentReplay).toBe(true);
    expect(await walletBalance(a.walletId)).toBe('20.00');
  }, 30000);

  test('mesma idempotency key com payload diferente resulta em conflito', async () => {
    const body = await fixture();
    const key = `${body.providerId}:${body.externalTransactionId}`;
    await processBet.execute(body, key);

    await expect(processBet.execute(
      { ...body, money: { amount: '40.00', currency: 'BRL' } }, key,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(await debitEntries(body.walletId)).toBe(1);
  }, 30000);

  test('replay devolve o saldo original mesmo depois de outra aposta', async () => {
    const original = await fixture();
    const firstKey = `${original.providerId}:${original.externalTransactionId}`;
    const first = await processBet.execute(original, firstKey);

    const second = {
      ...original,
      externalTransactionId: randomUUID(),
      money: { amount: '10.00', currency: 'BRL' },
    };
    await processBet.execute(second, `${second.providerId}:${second.externalTransactionId}`);
    const replay = await processBet.execute(original, firstKey);

    expect(first.balance.amount).toBe('70.00');
    expect(replay.balance.amount).toBe('70.00');
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
    expect(await walletBalance(original.walletId)).toBe('60.00');
  }, 30000);

  test('saldo insuficiente é registrado como REJECTED sem débito', async () => {
    const body = await fixture();
    body.money.amount = '150.00';
    const key = `${body.providerId}:${body.externalTransactionId}`;
    const rejected = await processBet.execute(body, key);

    expect(rejected.status).toBe(WagerTransactionStatus.Rejected); 
    expect(rejected.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejected.balance.amount).toBe('100.00');
    expect(await walletBalance(body.walletId)).toBe('100.00');
    expect(await debitEntries(body.walletId)).toBe(0);

    const replay = await processBet.execute(body, key);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(rejected.transactionId);
  }, 30000);

});
