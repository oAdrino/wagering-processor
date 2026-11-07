import { EntitySchema } from '@mikro-orm/core';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction';
import { WalletRecord } from './wallet.record';

/** Persistência separada da entidade de domínio WagerTransaction. */
export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  wallet!: WalletRecord;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: WagerTransactionKind;
  moneyAmount!: string;
  currency!: string;
  referenceExternalTransactionId?: string;
  referenceTransaction?: WagerTransactionRecord;
  status!: WagerTransactionStatus;
  failureCode?: FailureCode;
  createdAt!: Date;
  processedAt?: Date;
  // Saldo da resposta original; evita devolver saldo atualizado em replays.
  resultBalanceAmount?: string;
  // Apoio ao worker que reprocessará referências fora de ordem.
  attempts!: number;
  nextAttemptAt?: Date;
}

export const WagerTransactionRecordSchema = new EntitySchema({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id', length: 128 },
    externalTransactionId: {
      type: 'string', fieldName: 'external_transaction_id', length: 255,
    },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key', length: 255 },
    payloadHash: { type: 'string', fieldName: 'payload_hash', length: 64 },
    wallet: {
      kind: 'm:1', entity: () => WalletRecord,
      fieldName: 'wallet_id', deleteRule: 'restrict',
    },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id', length: 255 },
    gameId: { type: 'string', fieldName: 'game_id', length: 255 },
    kind: { type: 'string', length: 12 },
    moneyAmount: {
      type: 'string', fieldName: 'money_amount', columnType: 'numeric(38,2)',
    },
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: {
      type: 'string', fieldName: 'reference_external_transaction_id',
      length: 255, nullable: true,
    },
    referenceTransaction: {
      kind: 'm:1', entity: () => WagerTransactionRecord,
      fieldName: 'reference_transaction_id', nullable: true,
      deleteRule: 'restrict',
    },
    status: { type: 'string', length: 20 },
    failureCode: {
      type: 'string', fieldName: 'failure_code', length: 64, nullable: true,
    },
    createdAt: { type: Date, fieldName: 'created_at', columnType: 'timestamptz' },
    processedAt: {
      type: Date, fieldName: 'processed_at', columnType: 'timestamptz',
      nullable: true,
    },
    resultBalanceAmount: {
      type: 'string', fieldName: 'result_balance_amount',
      columnType: 'numeric(38,2)', nullable: true,
    },
    attempts: { type: 'integer', default: 0 },
    nextAttemptAt: {
      type: Date, fieldName: 'next_attempt_at', columnType: 'timestamptz',
      nullable: true,
    },
  },
  uniques: [
    {
      name: 'uq_wager_provider_external',
      properties: ['providerId', 'externalTransactionId'],
    },
    {
      name: 'uq_wager_provider_idempotency',
      properties: ['providerId', 'idempotencyKey'],
    },
    {
      name: 'uq_wager_active_reversal',
      properties: ['providerId', 'referenceExternalTransactionId', 'kind'],
      where: "kind IN ('REFUND', 'ROLLBACK') AND status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')",
    },
  ],
  indexes: [
    { name: 'idx_wager_wallet_created', properties: ['wallet', 'createdAt', 'id'] },
    { name: 'idx_wager_pending_references', properties: ['status', 'nextAttemptAt'] },
  ],
  checks: [
    {
      name: 'chk_wager_kind',
      expression: "kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')",
    },
    {
      name: 'chk_wager_status',
      expression: "status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')",
    },
    { name: 'chk_wager_amount', expression: "money_amount >= 0 AND (kind = 'LOSS' OR money_amount > 0)" },
    { name: 'chk_wager_attempts', expression: 'attempts >= 0' },
    {
      name: 'chk_wager_reference_required',
      expression: "kind NOT IN ('REFUND', 'ROLLBACK') OR NULLIF(BTRIM(reference_external_transaction_id), '') IS NOT NULL",
    },
    {
      name: 'chk_wager_processed_reference',
      expression: "status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NOT NULL",
    },
    {
      name: 'chk_wager_failure_code',
      expression: "status NOT IN ('REJECTED', 'FAILED') OR failure_code IS NOT NULL",
    },
    {
      name: 'chk_wager_processed_at',
      expression: "status <> 'PROCESSED' OR processed_at IS NOT NULL",
    },
    {
      name: 'chk_wager_result_balance_non_negative',
      expression: 'result_balance_amount IS NULL OR result_balance_amount >= 0',
    },
  ],
});
