import { describe, expect, test } from 'bun:test';
import { Money } from '../value-objects/money';
import { LedgerDirection } from './wallet-ledger-entry';
import {
  FailureCode,
  InvalidTransactionStateError,
  InvalidWagerReferenceError,
  InvalidWagerTransactionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from './wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function makeTransaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: 'wager-1',
    providerId: 'provider-a',
    externalTransactionId: 'bet-1',
    idempotencyKey: 'provider-a:bet-1',
    payloadHash: 'hash-original',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('30.00'),
    ...overrides,
  });
}

const processedBet = (): WagerTransaction => {
  const bet = makeTransaction();
  bet.markProcessed(undefined, new Date('2026-11-07T10:00:00.000Z'));
  return bet;
};

const reversal = (kind: WagerTransactionKind, ref = 'bet-1') => makeTransaction({
  id: `${kind}-1`,
  kind,
  externalTransactionId: `${kind}-1`,
  idempotencyKey: `provider-a:${kind}-1`,
  referenceExternalTransactionId: ref,
});

describe('WagerTransaction', () => {
  test('começa PENDING com os identificadores do README', () => {
    const transaction = makeTransaction();
    expect(transaction.status).toBe(WagerTransactionStatus.Pending);
    expect(transaction.providerId).toBe('provider-a');
    expect(transaction.externalTransactionId).toBe('bet-1');
    expect(transaction.money.toJSON().amount).toBe('30.00');
  });

  test('REFUND e ROLLBACK precisam de referência externa', () => {
    for (const kind of [WagerTransactionKind.Refund, WagerTransactionKind.Rollback]) {
      expect(() => makeTransaction({ kind })).toThrow(InvalidWagerReferenceError);
    }
  });

  test('processa BET e preserva data e resultado do estado', () => {
    const transaction = makeTransaction();
    const at = new Date('2026-11-07T12:00:00.000Z');
    transaction.markProcessed(undefined, at);
    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.isTerminal()).toBe(true);
    at.setFullYear(2000);
    expect(transaction.processedAt?.toISOString()).toBe('2026-11-07T12:00:00.000Z');
  });

  test('não permite alterar transações em estado terminal', () => {
    const transaction = processedBet();
    expect(() => transaction.reject(FailureCode.InvalidReference)).toThrow(InvalidTransactionStateError);
    expect(() => transaction.markProcessed(undefined, new Date())).toThrow(InvalidTransactionStateError);
  });

  test('REJECTED é terminal e guarda failureCode', () => {
    const transaction = makeTransaction();
    transaction.reject(FailureCode.InsufficientFunds);
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(() => transaction.fail(FailureCode.PermanentInfrastructureFailure))
      .toThrow(InvalidTransactionStateError);
  });

  test('FAILED é terminal', () => {
    const transaction = makeTransaction();
    transaction.fail(FailureCode.PermanentInfrastructureFailure);
    expect(transaction.isTerminal()).toBe(true);
    expect(transaction.status).toBe(WagerTransactionStatus.Failed);
  });

  test('REFUND aguarda referência quando chega fora de ordem', () => {
    const refund = reversal(WagerTransactionKind.Refund);
    refund.markPendingReference();
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.isTerminal()).toBe(false);
    expect(() => refund.markProcessed(undefined, new Date()))
      .toThrow(InvalidWagerReferenceError);
    refund.markProcessed('internal-bet-id', new Date());
    expect(refund.referenceTransactionId).toBe('internal-bet-id');
  });

  test('BET não pode entrar em PENDING_REFERENCE', () => {
    expect(() => makeTransaction().markPendingReference()).toThrow(InvalidWagerReferenceError);
  });

  test('LOSS não altera saldo nem gera direção de ledger', () => {
    const loss = makeTransaction({ kind: WagerTransactionKind.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });

  test('BET debita, WIN e OPENING creditam', () => {
    expect(makeTransaction().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(makeTransaction({ kind: WagerTransactionKind.Win }).ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
    expect(makeTransaction({ kind: WagerTransactionKind.Opening }).ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
  });

  test('REFUND de BET processada credita', () => {
    const refund = reversal(WagerTransactionKind.Refund);
    expect(refund.ledgerDirectionFor(processedBet())).toBe(LedgerDirection.Credit);
  });

  test('ROLLBACK de BET credita, de WIN e REFUND debita', () => {
    expect(reversal(WagerTransactionKind.Rollback)
      .ledgerDirectionFor(processedBet())).toBe(LedgerDirection.Credit);

    const win = makeTransaction({
      kind: WagerTransactionKind.Win,
      externalTransactionId: 'win-1',
    });
    win.markProcessed(undefined, new Date());
    expect(reversal(WagerTransactionKind.Rollback, 'win-1')
      .ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);

    const refund = reversal(WagerTransactionKind.Refund);
    refund.markProcessed('internal-bet-id', new Date());
    expect(reversal(WagerTransactionKind.Rollback, 'REFUND-1')
      .ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('rejeita referência de outra carteira ou valor diferente', () => {
    const otherWallet = makeTransaction({ walletId: 'other-wallet' });
    otherWallet.markProcessed(undefined, new Date());
    expect(() => reversal(WagerTransactionKind.Rollback).ledgerDirectionFor(otherWallet))
      .toThrow(InvalidWagerReferenceError);
    const wrongAmount = makeTransaction({ money: brl('35.00') });
    wrongAmount.markProcessed(undefined, new Date());
    expect(() => reversal(WagerTransactionKind.Refund).ledgerDirectionFor(wrongAmount))
      .toThrow(InvalidWagerReferenceError);
  });

  test('rejeita REFUND de WIN e referência não processada', () => {
    const win = makeTransaction({
      kind: WagerTransactionKind.Win,
      externalTransactionId: 'win-1',
    });
    win.markProcessed(undefined, new Date());
    expect(() => reversal(WagerTransactionKind.Refund, 'win-1').ledgerDirectionFor(win))
      .toThrow(InvalidWagerReferenceError);
    expect(() => reversal(WagerTransactionKind.Refund).ledgerDirectionFor(makeTransaction()))
      .toThrow(InvalidWagerReferenceError);
  });

  test('distingue replay idêntico de payload divergente', () => {
    const transaction = makeTransaction();
    expect(transaction.matchesPayload('hash-original')).toBe(true);
    expect(transaction.matchesPayload('hash-diferente')).toBe(false);
  });

  test('rehydrate conserva status, referência e failureCode', () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'wager-1',
      providerId: 'provider-a',
      externalTransactionId: 'rollback-1',
      idempotencyKey: 'provider-a:rollback-1',
      payloadHash: 'hash',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: WagerTransactionKind.Rollback,
      money: brl('30.00'),
      referenceExternalTransactionId: 'bet-1',
      status: WagerTransactionStatus.Rejected,
      createdAt: new Date('2026-11-07T08:00:00.000Z'),
      failureCode: FailureCode.ReferenceExpired,
    });
    expect(transaction.status).toBe(WagerTransactionStatus.Rejected);
    expect(transaction.failureCode).toBe(FailureCode.ReferenceExpired);
    expect(transaction.referenceExternalTransactionId).toBe('bet-1');
    expect(transaction.createdAt.toISOString()).toBe('2026-11-07T08:00:00.000Z');
  });

  test('não aceita BET de zero e campos obrigatórios vazios', () => {
    expect(() => makeTransaction({ money: brl('0.00') }))
      .toThrow(InvalidWagerTransactionError);
    expect(() => makeTransaction({ providerId: '   ' }))
      .toThrow(InvalidWagerTransactionError);
  });
});
