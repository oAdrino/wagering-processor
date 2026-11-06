import { describe, expect, test } from 'bun:test';
import { Money, InvalidMoneyError, CurrencyMismatchError } from './money';

describe('Money', () => {
  test('deve criar um valor monetário válido', () => {
    const money = Money.from({
      amount: '25.50',
      currency: 'BRL',
    });

    expect(money.toJSON()).toEqual({
      amount: '25.50',
      currency: 'BRL',
    });
  });

  test('deve somar valores sem perder precisão', () => {
    const a = Money.from({
      amount: '0.10',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '0.20',
      currency: 'BRL',
    });

    expect(a.add(b).toJSON().amount).toBe('0.30');
  });

  test('deve subtrair valores', () => {
    const saldo = Money.from({
      amount: '100.00',
      currency: 'BRL',
    });

    const aposta = Money.from({
      amount: '30.00',
      currency: 'BRL',
    });

    expect(saldo.subtract(aposta).toJSON().amount).toBe('70.00');
  });

  test('deve rejeitar valores inválidos', () => {
    const invalidos = [
      '',
      '10',
      '10.0',
      '10.001',
      '-10.00',
      'NaN',
      'Infinity',
      '1e3',
      ' 10.00',
    ];

    for (const amount of invalidos) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    }
  });

  test('não deve permitir somar moedas de diferentes tipos', () => {
    const brl = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const usd = Money.from({
      amount: '10.00',
      currency: 'USD',
    });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  });

  test('deve suportar valores muito grandes', () => {
    const money = Money.from({
      amount: '90071992544740993.01',
      currency: 'BRL',
    });

    expect(money.toJSON().amount).toBe('90071992544740993.01');
  });

  test('deve ser imutavel', () => {
    const original = Money.from({
      amount: '50.00',
      currency: 'BRL',
    });

    const resultado = original.add(
      Money.from({
        amount: '20.00',
        currency: 'BRL',
      }),
    );

    expect(original.toJSON().amount).toBe('50.00');
    expect(resultado.toJSON().amount).toBe('70.00');
  });

  test('deve permitir valor negativo internamente', () => {
    const a = Money.from({
      amount: '10.00',
      currency: 'BRL',
    });

    const b = Money.from({
      amount: '20.00',
      currency: 'BRL',
    });

    expect(a.subtract(b).toJSON().amount).toBe('-10.00');
    expect(a.subtract(b).isNegative()).toBe(true);
  });
});
