
import { describe, expect, test } from 'bun:test';
import { Money } from '../value-objects/money';

import {
  WalletLedgerEntry,
  LedgerDirection,
  InvalidLedgerEntryError,
  type CreateLedgerEntryProps,
} from './wallet-ledger-entry';

const brl = (amount: string) =>
  Money.from({ amount, currency: 'BRL' });

function createEntry(
  overrides: Partial<CreateLedgerEntryProps> = {},
): WalletLedgerEntry {
  return WalletLedgerEntry.create({
    id: 'ledger-1',
    walletId: 'wallet-1',
    transactionId: 'transaction-1',
    direction: LedgerDirection.Debit,
    money: brl('30.00'),
    balanceBefore: brl('100.00'),
    balanceAfter: brl('70.00'),
    ...overrides,
  });
}

describe('WalletLedgerEntry', () => {
  test('deve criar débito consistente', () => {
    const entry = createEntry();

    expect(entry.isBalanced()).toBe(true);
    expect(entry.direction).toBe(LedgerDirection.Debit);
  });

  test('deve criar crédito consistente', () => {
    const entry = createEntry({
      direction: LedgerDirection.Credit,
      money: brl('50.00'),
      balanceAfter: brl('150.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test('deve rejeitar saldo inconsistente', () => {
    expect(() =>
      createEntry({
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('deve rejeitar movimentação zero', () => {
    expect(() =>
      createEntry({
        money: brl('0.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('deve rejeitar moedas diferentes', () => {
    expect(() =>
      createEntry({
        money: Money.from({
          amount: '30.00',
          currency: 'USD',
        }),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('deve rejeitar saldo negativo', () => {
    expect(() =>
      createEntry({
        money: brl('120.00'),
        balanceAfter: brl('20.00').negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('deve ser imutável', () => {
    const entry = createEntry();

    expect(Object.isFrozen(entry)).toBe(true);

    const date = entry.createdAt;
    date.setFullYear(2000);

    expect(entry.createdAt.getFullYear())
      .not.toBe(2000);
  });

  test('deve reidratar preservando os dados', () => {
    const original = createEntry();

    const restored = WalletLedgerEntry.rehydrate({
      id: original.id,
      walletId: original.walletId,
      transactionId: original.transactionId,
      direction: original.direction,
      money: original.money,
      balanceBefore: original.balanceBefore,
      balanceAfter: original.balanceAfter,
      createdAt: original.createdAt,
    });

    expect(restored.isBalanced()).toBe(true);
    expect(restored.createdAt.getTime())
      .toBe(original.createdAt.getTime());
  });
});
