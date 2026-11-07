import {
  Money,
  CurrencyMismatchError,
} from'../value-objects/money';

//Erros de domínio

export class InsufficientFundsError extends Error {
  constructor() {
    super('Saldo insuficiente para realizar a operação');
    this.name = 'InsufficientFundsError';
  }
}

export class InvalidWalletAmountError extends Error {
  constructor() {
    super('O valor da movimentação deve ser positivo e maior que zero');
    this.name = 'InvalidWalletAmountError';
  }
}

export class InvalidInitialBalanceError extends Error {
  constructor() {
    super('O saldo inicial não pode ser negativo');
    this.name = 'InvalidInitialBalanceError';
  }
}

// Representa os dados de uma carteira armazenada.

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

// Resultado de uma movimentação financeira.

export interface BalanceMovement {
  balanceBefore: Money;
  balanceAfter: Money;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date
  ) {}

  //Cria uma carteira nova.

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidInitialBalanceError();
    }

    const now = new Date();

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now
    );
  }

  //Reconstrói uma carteira já persistida.

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt)
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(amount: Money): BalanceMovement {
    this.validateMovement(amount);

    if(this._balance.isLessThan(amount)) {
      throw new InsufficientFundsError();
    }

    const newBalance = this._balance.subtract(amount);

    return this.applyBalance(newBalance);
  }

  credit(amount: Money): BalanceMovement {
    this.validateMovement(amount);

    const newBalance = this._balance.add(amount);

    return this.applyBalance(newBalance);
  }

  private validateMovement(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new CurrencyMismatchError();
    }

    if (!amount.isPositive()) {
      throw new InvalidWalletAmountError();
    }
  }

  private applyBalance(newBalance: Money): BalanceMovement {
    const balanceBefore = this._balance;

    this._balance = newBalance;
    this._version++;
    this._updatedAt = new Date();

    return {
      balanceBefore,
      balanceAfter: this._balance,
    };
  }
}  