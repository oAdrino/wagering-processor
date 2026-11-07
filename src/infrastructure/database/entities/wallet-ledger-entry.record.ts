
import { EntitySchema } from '@mikro-orm/core';
import { WalletRecord } from './wallet.record';
import { WagerTransactionRecord } from './wager-transaction.record';

import { LedgerDirection } from
  '../../../domain/entities/wallet-ledger-entry';

export class WalletLedgerEntryRecord {
  id!: string;
  wallet!: WalletRecord;
  transaction!: WagerTransactionRecord;
  direction!: LedgerDirection;
  moneyAmount!: string;
  currency!: string;
  balanceBeforeAmount!: string;
  balanceAfterAmount!: string;
  createdAt!: Date;
}

export const WalletLedgerEntryRecordSchema = new EntitySchema({
  class: WalletLedgerEntryRecord,
  tableName: 'wallet_ledger_entries',

  properties: {
    id: {
      type: 'uuid',
      primary: true,
    },

    wallet: {
      kind: 'm:1',
      entity: () => WalletRecord,
      fieldName: 'wallet_id',
      deleteRule: 'restrict',
    },

    transaction: {
      kind: 'm:1',
      entity: () => WagerTransactionRecord,
      fieldName: 'transaction_id',
      deleteRule: 'restrict',
    },

    direction: {
      type: 'string',
      length: 6,
    },

    moneyAmount: {
      type: 'string',
      fieldName: 'money_amount',
      columnType: 'numeric(38,2)',
    },

    currency: {
      type: 'string',
      length: 3,
    },

    balanceBeforeAmount: {
      type: 'string',
      fieldName: 'balance_before_amount',
      columnType: 'numeric(38,2)',
    },

    balanceAfterAmount: {
      type: 'string',
      fieldName: 'balance_after_amount',
      columnType: 'numeric(38,2)',
    },

    createdAt: {
      type: Date,
      fieldName: 'created_at',
      columnType: 'timestamptz',
    },
  },

  uniques: [
    {
      name: 'uq_ledger_wallet_transaction',
      properties: ['wallet', 'transaction'],
    },
  ],

  indexes: [
    {
      name: 'idx_ledger_wallet_created',
      properties: ['wallet', 'createdAt', 'id'],
    },
  ],

  checks: [
    {
      name: 'chk_ledger_direction',
      expression: "direction IN ('DEBIT', 'CREDIT')",
    },
    {
      name: 'chk_ledger_money_positive',
      expression: 'money_amount > 0',
    },
    {
      name: 'chk_ledger_balances_non_negative',
      expression:
        'balance_before_amount >= 0 AND balance_after_amount >= 0',
    },
    {
      name: 'chk_ledger_arithmetic',
      expression: `
        (
          direction = 'CREDIT'
          AND balance_after_amount = balance_before_amount + money_amount
        )
        OR
        (
          direction = 'DEBIT'
          AND balance_after_amount = balance_before_amount - money_amount
        )
      `,
    },
  ],
});
