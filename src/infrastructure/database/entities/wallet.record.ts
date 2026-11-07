
import { EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletRecordSchema = new EntitySchema({
  class: WalletRecord,
  tableName: 'wallets',

  properties: {
    id: {
      type: 'uuid',
      primary: true,
    },

    playerId: {
      type: 'uuid',
      fieldName: 'player_id',
    },

    currency: {
      type: 'string',
      length: 3,
    },

    balanceAmount: {
      type: 'string',
      fieldName: 'balance_amount',
      columnType: 'numeric(38,2)',
    },

    version: {
      type: 'integer',
    },

    createdAt: {
      type: Date,
      fieldName: 'created_at',
      columnType: 'timestamptz',
    },

    updatedAt: {
      type: Date,
      fieldName: 'updated_at',
      columnType: 'timestamptz',
    },
  },

  uniques: [
    {
      name: 'uq_wallet_player_currency',
      properties: ['playerId', 'currency'],
    },
  ],

  checks: [
    {
      name: 'chk_wallet_balance_non_negative',
      expression: 'balance_amount >= 0',
    },
    {
      name: 'chk_wallet_version_positive',
      expression: 'version >= 1',
    },
  ],
});
