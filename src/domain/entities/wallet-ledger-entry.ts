
import { Money } from '../value-objects/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLedgerEntryError';
  }
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
}

export interface LedgerEntryState
  extends CreateLedgerEntryProps {
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(
    props: CreateLedgerEntryProps,
  ): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        'O valor do lançamento deve ser positivo',
      );
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(),
    );

    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        'O lançamento financeiro é inconsistente',
      );
    }

    return entry;
  }

  static rehydrate(
    state: LedgerEntryState,
  ): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    if (
      !this.money.isPositive() ||
      this.balanceBefore.isNegative() ||
      this.balanceAfter.isNegative()
    ) {
      return false;
    }

    switch (this.direction) {
      case LedgerDirection.Debit:
        return this.balanceBefore
          .subtract(this.money)
          .equals(this.balanceAfter);

      case LedgerDirection.Credit:
        return this.balanceBefore
          .add(this.money)
          .equals(this.balanceAfter);

      default:
        return false;
    }
  }
}
