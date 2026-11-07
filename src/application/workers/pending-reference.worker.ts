import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { LockMode, MikroORM } from '@mikro-orm/core';

import { Money } from '../../domain/value-objects/money';
import { Wallet, InsufficientFundsError } from '../../domain/entities/wallet';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry';
import { WalletRecord } from '../../infrastructure/database/entities/wallet.record';
import { WagerTransactionRecord } from '../../infrastructure/database/entities/wager-transaction.record';
import { WalletLedgerEntryRecord } from '../../infrastructure/database/entities/wallet-ledger-entry.record';

// Limites do reprocessamento: evitam deixar uma referência ausente pendente para sempre.
export const PENDING_REFERENCE_POLICY = {
  intervalMs: 2_000,
  batchSize: 20,
  maxAttempts: 8,
  ttlMs: 30 * 60_000,
  initialBackoffMs: 5_000,
  maxBackoffMs: 5 * 60_000,
} as const;

type Outcome = 'processed' | 'rejected' | 'rescheduled' | 'skipped';

function rehydrate(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.wallet.id,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    money: Money.from({ amount: record.moneyAmount, currency: record.currency }),
    referenceExternalTransactionId: record.referenceExternalTransactionId,
    createdAt: record.createdAt,
    status: record.status,
    referenceTransactionId: record.referenceTransaction?.id,
    failureCode: record.failureCode,
    processedAt: record.processedAt,
  });
}

/**
 * Reprocessa REFUND/ROLLBACK que chegaram antes da transação referenciada.
 * A unidade de exclusão mútua é a wallet, por lock de linha no PostgreSQL.
 * O banco, não este timer, garante a segurança entre múltiplos processos.
 */
@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<number>;
  private stopping = false;

  constructor(private readonly orm: MikroORM) {}

  onModuleInit(): void {
    if (process.env.PENDING_REFERENCE_WORKER_ENABLED === '0') {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, PENDING_REFERENCE_POLICY.intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }

  private async tick(): Promise<void> {
    if (this.stopping || this.inFlight) return;
    const task = this.runOnce();
    this.inFlight = task;
    try {
      await task;
    } catch (error) {
      // Infra temporariamente indisponível: não transformar em REJECTED.
      this.logger.error('Falha no ciclo do worker de referências', error);
    } finally {
      this.inFlight = undefined;
    }
  }

  /** Publicado para permitir testes de integração determinísticos sem timers. */
  async runOnce(now = new Date()): Promise<number> {
    const due = await this.orm.em.fork().find(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        nextAttemptAt: { $lte: now },
      },
      {
        populate: ['wallet'],
        orderBy: { nextAttemptAt: 'asc' },
        limit: PENDING_REFERENCE_POLICY.batchSize,
      },
    );

    let handled = 0;
    for (const row of due) {
      // Uma falha transitória em uma operação não descarta as demais.
      try {
        const outcome = await this.processOne(row.id, row.wallet.id, now);
        if (outcome !== 'skipped') handled++;
      } catch (error) {
        this.logger.error(`Falha transitória ao reprocessar ${row.id}`, error);
      }
    }
    return handled;
  }

  private async processOne(
    transactionId: string,
    walletId: string,
    now: Date,
  ): Promise<Outcome> {
    return this.orm.em.fork().transactional(async (em) => {
      // IMPORTANTE: mesmo lock e mesma ordem utilizados nos use cases HTTP.
      const walletRow = await em.findOne(WalletRecord, { id: walletId }, {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      });
      if (!walletRow) throw new Error(`Wallet ${walletId} inexistente`);

      // Reconsulto depois do lock, porque outro worker pode ter resolvido a operação.
      const row = await em.findOne(WagerTransactionRecord, {
        id: transactionId,
        status: WagerTransactionStatus.PendingReference,
      }, { populate: ['wallet', 'referenceTransaction'] });
      if (!row || (row.nextAttemptAt && row.nextAttemptAt > now)) return 'skipped';

      const wager = rehydrate(row);
      const wallet = Wallet.rehydrate({
        id: walletRow.id,
        playerId: walletRow.playerId,
        currency: walletRow.currency,
        balance: Money.from({
          amount: walletRow.balanceAmount,
          currency: walletRow.currency,
        }),
        version: walletRow.version,
        createdAt: walletRow.createdAt,
        updatedAt: walletRow.updatedAt,
      });
      const referenceExternalId = wager.referenceExternalTransactionId;
      if (!wager.requiresReference() || !referenceExternalId) {
        // Registro inconsistente: não pode processar como financeiro.
        wager.reject(FailureCode.InvalidReference);
        return this.persistState(row, wager, walletRow, 'rejected');
      }

      const refRow = await em.findOne(WagerTransactionRecord, {
        providerId: wager.providerId,
        externalTransactionId: referenceExternalId,
      }, { populate: ['wallet'] });

      // Referência não existe OU foi aceita mas ainda não chegou a estado terminal.
      if (!refRow || [
        WagerTransactionStatus.Pending,
        WagerTransactionStatus.PendingReference,
      ].includes(refRow.status)) {
        row.attempts += 1;
        if (now.getTime() - row.createdAt.getTime() >= PENDING_REFERENCE_POLICY.ttlMs) {
          wager.reject(FailureCode.ReferenceExpired);
          return this.persistState(row, wager, walletRow, 'rejected');
        }
        if (row.attempts >= PENDING_REFERENCE_POLICY.maxAttempts) {
          wager.reject(refRow ? FailureCode.ReferenceExpired : FailureCode.ReferenceNotFound);
          return this.persistState(row, wager, walletRow, 'rejected');
        }
        const delay = Math.min(
          PENDING_REFERENCE_POLICY.initialBackoffMs * (2 ** row.attempts),
          PENDING_REFERENCE_POLICY.maxBackoffMs,
        );
        row.nextAttemptAt = new Date(now.getTime() + delay);
        return 'rescheduled';
      }

      const reference = rehydrate(refRow);
      const allowedKinds: WagerTransactionKind[] = wager.kind === WagerTransactionKind.Refund
        ? [WagerTransactionKind.Bet]
        : [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
      let invalid: FailureCode | undefined;
      if (reference.status !== WagerTransactionStatus.Processed ||
          !allowedKinds.includes(reference.kind)) {
        invalid = FailureCode.InvalidReference;
      } else if (reference.providerId !== wager.providerId ||
                 reference.walletId !== wallet.id ||
                 reference.playerId !== wallet.playerId ||
                 reference.roundId !== wager.roundId ||
                 reference.money.currency !== wager.money.currency) {
        invalid = FailureCode.ReferenceScopeMismatch;
      } else if (!wager.money.equals(reference.money)) {
        invalid = FailureCode.ReferenceAmountMismatch;
      }

      if (invalid) {
        wager.reject(invalid);
        return this.persistState(row, wager, walletRow, 'rejected');
      }

      const direction = wager.ledgerDirectionFor(reference);
      let movement: ReturnType<Wallet['credit']>;
      try {
        movement = direction === LedgerDirection.Credit
          ? wallet.credit(wager.money)
          : wallet.debit(wager.money);
      } catch (error) {
        if (!(error instanceof InsufficientFundsError)) throw error;
        wager.reject(FailureCode.ReversalInsufficientFunds);
        return this.persistState(row, wager, walletRow, 'rejected');
      }

      wager.markProcessed(reference.id, now);
      row.referenceTransaction = refRow;
      walletRow.balanceAmount = wallet.balance.toJSON().amount;
      walletRow.version = wallet.version;
      walletRow.updatedAt = wallet.updatedAt;
      const ledger = WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: wallet.id,
        transactionId: wager.id,
        direction,
        money: wager.money,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
      });
      em.create(WalletLedgerEntryRecord, {
        id: ledger.id,
        wallet: walletRow,
        transaction: row,
        direction: ledger.direction,
        moneyAmount: ledger.money.toJSON().amount,
        currency: ledger.money.currency,
        balanceBeforeAmount: ledger.balanceBefore.toJSON().amount,
        balanceAfterAmount: ledger.balanceAfter.toJSON().amount,
        createdAt: ledger.createdAt,
      });
      return this.persistState(row, wager, walletRow, 'processed');
    }, { clear: true });
  }

  private persistState(
    row: WagerTransactionRecord,
    wager: WagerTransaction,
    wallet: WalletRecord,
    outcome: 'processed' | 'rejected',
  ): Outcome {
    row.status = wager.status;
    row.failureCode = wager.failureCode;
    row.processedAt = wager.processedAt;
    row.resultBalanceAmount = wallet.balanceAmount;
    row.nextAttemptAt = undefined;
    return outcome;
  }
}
