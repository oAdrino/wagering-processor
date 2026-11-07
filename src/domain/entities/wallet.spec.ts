import { describe, expect, test } from 'bun:test';
import { Money } from '../value-objects/money';
import { Wallet, InsufficientFundsError } from './wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function createWallet(): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl('100.00'),
  });
}

describe('Wallet', () => {
  test('deve criar carteira com versão 1', () => {
    const wallet = createWallet();

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('deve debitar corretamente', () => {
    const wallet = createWallet();

    wallet.debit(brl('30.00'));

    expect(wallet.balance.toJSON().amount).toBe('70.00');
    expect(wallet.version).toBe(2);
  });

  test('deve creditar corretamente', () => {
    const wallet = createWallet();

    wallet.credit(brl('50.00'));

    expect(wallet.balance.toJSON().amount).toBe('150.00');
    expect(wallet.version).toBe(2);
  });

  test('não deve permitir saldo negativo', () => {
    const wallet = createWallet();

    expect(() => wallet.debit(brl('150.00'))).toThrow(InsufficientFundsError);

    expect(wallet.balance.toJSON().amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('não deve permitir outra moeda', () => {
    const wallet = createWallet();

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => wallet.debit(usd)).toThrow();

    expect(wallet.balance.toJSON().amount).toBe('100.00');
  });

  test('deve permitir debitar todo o saldo', () => {
    const wallet = createWallet();

    wallet.debit(brl('100.00'));

    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(2);
  });

  test('não deve permitir crédito de valor zero', () => {
    const wallet = createWallet();
    
    expect(() => wallet.credit(brl('0.00'))).toThrow();
    expect(wallet.version).toBe(1);
  });

  test('deve restaurar uma carteira existente', () => {
    const original = createWallet();
    
    original.debit(brl('20.00'));

    const restored = Wallet.rehydrate({
      id: original.id,
      playerId: original.playerId,
      currency: original.currency,
      balance: original.balance,
      version: original.version,
      createdAt: original.createdAt,
      updatedAt: original.updatedAt,
    });

    expect(restored.balance.toJSON().amount).toBe('80.00');
    expect(restored.version).toBe(2);
  });

  test('deve permitir abrir a carteira sem saldo', () => {
    const wallet = Wallet.open({
      id: 'wallet-zero',
      playerId: 'player-zero',
      initialBalance: brl('0.00'),
    });
    
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });
})
