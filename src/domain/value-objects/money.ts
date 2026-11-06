export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor() {
    super('Operações entre moedas diferentes não são permitidas.');
    this.name = 'CurrencyMismatchError';
  }
}

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    //Verifica o formato da moeda

    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidMoneyError('Moeda inválida.');
    }

    //Exige uma string decimal positiva ou zero,
    //com exatamente duas casas decimais
    if (
      typeof amount !== 'string' ||
      !/^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(amount)
    ) {
      throw new InvalidMoneyError(
        'Valor deve ser uma string decimal com duas casas',
      );
    }

    const [integer, decimal] = amount.split('.');

    const cents = BigInt(integer) * 100n + BigInt(decimal);

    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    return Money.from({
      amount: '0.00',
      currency,
    });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    const negative = this.cents < 0n;

    const absolute = negative ? -this.cents : this.cents;

    const integer = absolute / 100n;

    const decimal = (absolute % 100n).toString().padStart(2, '0');

    return {
      amount: `${negative ? '-' : ''}${integer}.${decimal}`,
      currency: this.currency,
    };
  }

  toString(): string {
    const { amount, currency } = this.toJSON();
    return `${amount} ${currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError();
    }
  }
}
