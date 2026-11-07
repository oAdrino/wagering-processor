import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../value-objects/money';
import type { LedgerDirection } from './wallet-ledger-entry';

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Contrato para consumidores externos, com versão de envelope explícita. */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = new Date(props.occurredAt);
    this.data = Object.freeze(props.data);
  }
  toJSON() {
    return {
      eventId: this.eventId, eventType: this.eventType,
      aggregateId: this.aggregateId, correlationId: this.correlationId,
      causationId: this.causationId, occurredAt: this.occurredAt.toISOString(),
      version: this.version, data: this.data,
    };
  }
}

export interface WagerEventData {
  transactionId: string;
  providerId: string;
  walletId: string;
  kind: string;
  status: string;
  failureCode?: string;
  money: MoneyProps;
}
export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
}
export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
}
export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
}
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  static fromData(data: WalletBalanceChangedData): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: randomUUID(), aggregateId: data.walletId,
      correlationId: data.transactionId,
      occurredAt: new Date(), data,
    });
  }
}
