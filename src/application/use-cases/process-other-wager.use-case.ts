import { persistInbox, type InboxReceipt } from '../../infrastructure/messaging/inbox';
import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LockMode,
  MikroORM,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';

import { Money, InvalidMoneyError, type MoneyProps } from '../../domain/value-objects/money';
import { Wallet, InsufficientFundsError } from '../../domain/entities/wallet';
import { WalletLedgerEntry, LedgerDirection } from '../../domain/entities/wallet-ledger-entry';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import { WalletRecord } from '../../infrastructure/database/entities/wallet.record';
import { WagerTransactionRecord } from '../../infrastructure/database/entities/wager-transaction.record';
import { WalletLedgerEntryRecord } from '../../infrastructure/database/entities/wallet-ledger-entry.record';
import type { ProcessBetResult } from './process-bet.use-case';

type OtherKind =
  | WagerTransactionKind.Win
  | WagerTransactionKind.Loss
  | WagerTransactionKind.Refund
  | WagerTransactionKind.Rollback;

export interface ProcessOtherWagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: OtherKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_FIELDS = new Set([
  'providerId', 'externalTransactionId', 'playerId', 'walletId',
  'roundId', 'gameId', 'kind', 'money', 'referenceExternalTransactionId',
]);
const ACTIVE_STATUSES = [
  WagerTransactionStatus.Pending,
  WagerTransactionStatus.PendingReference,
  WagerTransactionStatus.Processed,
];

function parseRequest(body: unknown): { input: ProcessOtherWagerInput; money: Money } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Payload deve ser um objeto JSON');
  }
  const request = body as Record<string, unknown>;
  if (Object.keys(request).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new BadRequestException('Payload contém campos desconhecidos');
  }
  const requiredText: ReadonlyArray<[string, number]> = [
    ['providerId', 128], ['externalTransactionId', 255],
    ['playerId', 36], ['walletId', 36], ['roundId', 255], ['gameId', 255],
  ];
  for (const [field, limit] of requiredText) {
    const value = request[field];
    if (typeof value !== 'string' || !value.trim() || value.length > limit) {
      throw new BadRequestException(`Campo inválido: ${field}`);
    }
  }
  if (!UUID_PATTERN.test(request.playerId as string) ||
      !UUID_PATTERN.test(request.walletId as string)) {
    throw new BadRequestException('playerId e walletId devem ser UUIDs válidos');
  }
  const allowedKinds: readonly unknown[] = [
    WagerTransactionKind.Win, WagerTransactionKind.Loss,
    WagerTransactionKind.Refund, WagerTransactionKind.Rollback,
  ];
  if (!allowedKinds.includes(request.kind)) {
    throw new BadRequestException('Tipo de operação não permitido');
  }
  const kind = request.kind as OtherKind;
  const reference = request.referenceExternalTransactionId;
  if (reference !== undefined &&
      (typeof reference !== 'string' || !reference.trim() || reference.length > 255)) {
    throw new BadRequestException('referenceExternalTransactionId inválido');
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) &&
      typeof reference !== 'string') {
    throw new BadRequestException('REFUND e ROLLBACK exigem referenceExternalTransactionId');
  }
  if (kind === WagerTransactionKind.Loss && reference !== undefined) {
    throw new BadRequestException('LOSS não utiliza referência');
  }
  if (!request.money || typeof request.money !== 'object' || Array.isArray(request.money)) {
    throw new BadRequestException('money deve ser um objeto');
  }
  const rawMoney = request.money as Record<string, unknown>;
  if (Object.keys(rawMoney).some((key) => !['amount', 'currency'].includes(key))) {
    throw new BadRequestException('money contém campos desconhecidos');
  }
  let money: Money;
  try {
    money = Money.from(rawMoney as unknown as MoneyProps);
  } catch (error) {
    if (error instanceof InvalidMoneyError || error instanceof TypeError) {
      throw new BadRequestException('money inválido: utilize string decimal com duas casas');
    }
    throw error;
  }
  if (money.currency !== 'BRL' || money.isNegative() ||
      (kind !== WagerTransactionKind.Loss && !money.isPositive())) {
    throw new BadRequestException('Moeda inválida ou valor não permitido para a operação');
  }
  if (money.toJSON().amount.split('.')[0].length > 36) {
    throw new BadRequestException('Valor excede NUMERIC(38,2)');
  }
  return {
    input: {
      providerId: request.providerId as string,
      externalTransactionId: request.externalTransactionId as string,
      playerId: request.playerId as string,
      walletId: request.walletId as string,
      roundId: request.roundId as string,
      gameId: request.gameId as string,
      kind,
      money: money.toJSON(),
      ...(reference !== undefined ? { referenceExternalTransactionId: reference as string } : {}),
    },
    money,
  };
}

/** JSON canônico de campos de negócio (ordem explícita; sem header de idempotência). */
export function canonicalOtherWagerHash(input: ProcessOtherWagerInput): string {
  const canonical = JSON.stringify({
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    playerId: input.playerId,
    providerId: input.providerId,
    ...(input.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId } : {}),
    roundId: input.roundId,
    walletId: input.walletId,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function rehydrateReference(record: WagerTransactionRecord): WagerTransaction {
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

@Injectable()
export class ProcessOtherWagerUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(body: unknown, idempotencyKey: string | undefined, inbox?: InboxReceipt): Promise<ProcessBetResult> {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() ||
        idempotencyKey.length > 255) {
      throw new BadRequestException('Header Idempotency-Key obrigatório (máximo 255 caracteres)');
    }
    const { input, money } = parseRequest(body);
    const payloadHash = canonicalOtherWagerHash(input);

    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // Replays já concluídos não precisam de lock. A consulta é repetida após o lock.
        const existing = await em.findOne(WagerTransactionRecord, {
          providerId: input.providerId, idempotencyKey,
        });
        if (existing) { await persistInbox(em, inbox); return this.replay(existing, payloadHash); }

        // O bloqueio ocorre POR WALLET, não globalmente.
        const walletRecord = await em.findOne(WalletRecord, { id: input.walletId }, {
          lockMode: LockMode.PESSIMISTIC_WRITE,
        });
        if (!walletRecord) throw new NotFoundException('Wallet não encontrada');

        const previous = await em.findOne(WagerTransactionRecord, {
          providerId: input.providerId, idempotencyKey,
        });
        if (previous) { await persistInbox(em, inbox); return this.replay(previous, payloadHash); }

        const duplicateExternal = await em.findOne(WagerTransactionRecord, {
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
        });
        if (duplicateExternal) {
          throw new ConflictException('externalTransactionId já utilizado por esse provedor');
        }
        if (walletRecord.playerId.toLowerCase() !== input.playerId.toLowerCase() ||
            walletRecord.currency !== money.currency) {
          throw new BadRequestException('Wallet não pertence ao jogador ou à moeda informada');
        }

        const wallet = Wallet.rehydrate({
          id: walletRecord.id, playerId: walletRecord.playerId,
          currency: walletRecord.currency,
          balance: Money.from({ amount: walletRecord.balanceAmount, currency: walletRecord.currency }),
          version: walletRecord.version, createdAt: walletRecord.createdAt,
          updatedAt: walletRecord.updatedAt,
        });
        const wager = WagerTransaction.create({
          id: randomUUID(), providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey, payloadHash, walletId: wallet.id,
          playerId: wallet.playerId, roundId: input.roundId,
          gameId: input.gameId, kind: input.kind, money,
          referenceExternalTransactionId: input.referenceExternalTransactionId,
        });

        let referenceRecord: WagerTransactionRecord | null = null;
        let reference: WagerTransaction | undefined;
        let direction: LedgerDirection | undefined;
        let movement: ReturnType<Wallet['credit']> | undefined;
        let nextAttemptAt: Date | undefined;
        const hasReference = input.referenceExternalTransactionId !== undefined;

        if (hasReference) {
          referenceRecord = await em.findOne(WagerTransactionRecord, {
            providerId: input.providerId,
            externalTransactionId: input.referenceExternalTransactionId,
          }, { populate: ['wallet', 'referenceTransaction'] });
          if (referenceRecord) reference = rehydrateReference(referenceRecord);
        }

        if (wager.requiresReference() && !reference) {
          // O evento pode chegar antes da BET original. Não rejeito de imediato:
          // deixo a operação pendente para o worker tentar mais tarde.
          wager.markPendingReference();
          nextAttemptAt = new Date(Date.now() + 5000);
        } else {
          let failure: FailureCode | undefined;
          if (wager.requiresReference() && reference) {
            // Validamos o escopo ANTES de pedir ao domínio a direção do lançamento.
            if (reference.status !== WagerTransactionStatus.Processed ||
                (input.kind === WagerTransactionKind.Refund && reference.kind !== WagerTransactionKind.Bet) ||
                (input.kind === WagerTransactionKind.Rollback && ![
                  WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund,
                ].includes(reference.kind))) {
              failure = FailureCode.InvalidReference;
            } else if (reference.walletId !== wallet.id || reference.playerId !== wallet.playerId ||
                       reference.providerId !== input.providerId || reference.roundId !== input.roundId ||
                       reference.money.currency !== money.currency) {
              failure = FailureCode.ReferenceScopeMismatch;
            } else if (!money.equals(reference.money)) {
              failure = FailureCode.ReferenceAmountMismatch;
            } else {
              const duplicateReversal = await em.findOne(WagerTransactionRecord, {
                providerId: input.providerId,
                referenceExternalTransactionId: input.referenceExternalTransactionId,
                kind: input.kind,
                status: { $in: ACTIVE_STATUSES },
              });
              if (duplicateReversal) failure = FailureCode.DuplicateReversal;
            }
          } else if (input.kind === WagerTransactionKind.Win && hasReference) {
            // WIN pode referenciar BET, mas não exige referência.
            if (!reference || reference.kind !== WagerTransactionKind.Bet ||
                reference.status !== WagerTransactionStatus.Processed) {
              failure = FailureCode.InvalidReference;
            } else if (reference.walletId !== wallet.id || reference.playerId !== wallet.playerId ||
                       reference.providerId !== input.providerId || reference.roundId !== input.roundId ||
                       reference.money.currency !== money.currency) {
              failure = FailureCode.ReferenceScopeMismatch;
            }
          }

          if (failure) {
            wager.reject(failure);
          } else {
            if (input.kind === WagerTransactionKind.Loss) {
              wager.markProcessed(undefined, new Date());
            } else {
              direction = wager.ledgerDirectionFor(reference);
              try {
                movement = direction === LedgerDirection.Credit
                  ? wallet.credit(money)
                  : wallet.debit(money);
                wager.markProcessed(reference?.id, new Date());
              } catch (error) {
                if (error instanceof InsufficientFundsError) {
                  wager.reject(FailureCode.ReversalInsufficientFunds);
                } else {
                  throw error;
                }
              }
            }
          }
        }

        const balance = wallet.balance.toJSON();
        const wagerRecord = em.create(WagerTransactionRecord, {
          id: wager.id, providerId: wager.providerId,
          externalTransactionId: wager.externalTransactionId,
          idempotencyKey: wager.idempotencyKey, payloadHash: wager.payloadHash,
          wallet: walletRecord, playerId: wager.playerId, roundId: wager.roundId,
          gameId: wager.gameId, kind: wager.kind,
          moneyAmount: money.toJSON().amount, currency: money.currency,
          referenceExternalTransactionId: wager.referenceExternalTransactionId,
          referenceTransaction: referenceRecord ?? undefined,
          status: wager.status, failureCode: wager.failureCode,
          createdAt: wager.createdAt, processedAt: wager.processedAt,
          resultBalanceAmount: balance.amount,
          attempts: 0, nextAttemptAt,
        });

        if (movement && direction) {
          walletRecord.balanceAmount = balance.amount;
          walletRecord.version = wallet.version;
          walletRecord.updatedAt = wallet.updatedAt;
          const ledger = WalletLedgerEntry.create({
            id: randomUUID(), walletId: wallet.id, transactionId: wager.id,
            direction, money, balanceBefore: movement.balanceBefore,
            balanceAfter: movement.balanceAfter,
          });
          em.create(WalletLedgerEntryRecord, {
            id: ledger.id, wallet: walletRecord, transaction: wagerRecord,
            direction: ledger.direction, moneyAmount: ledger.money.toJSON().amount,
            currency: ledger.money.currency,
            balanceBeforeAmount: ledger.balanceBefore.toJSON().amount,
            balanceAfterAmount: ledger.balanceAfter.toJSON().amount,
            createdAt: ledger.createdAt,
          });
        }
        await persistInbox(em, inbox);
        await em.flush();
        return {
          transactionId: wager.id, status: wager.status, balance,
          idempotentReplay: false,
          ...(wager.failureCode ? { failureCode: wager.failureCode } : {}),
        };
      }, { clear: true });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        const readEm = this.orm.em.fork();
        const previous = await readEm.findOne(WagerTransactionRecord, {
          providerId: input.providerId, idempotencyKey,
        });
        if (previous) return this.replay(previous, payloadHash);
        const external = await readEm.findOne(WagerTransactionRecord, {
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
        });
        if (external) throw new ConflictException('externalTransactionId já utilizado por esse provedor');
        throw new ConflictException('Conflito de reversão concorrente');
      }
      throw error;
    }
  }

  private replay(record: WagerTransactionRecord, payloadHash: string): ProcessBetResult {
    if (record.payloadHash !== payloadHash) {
      throw new ConflictException('Idempotency-Key reutilizada com payload diferente');
    }
    if (!record.resultBalanceAmount) {
      throw new ConflictException('Transação anterior ainda não tem resultado persistido');
    }
    return {
      transactionId: record.id, status: record.status,
      balance: { amount: record.resultBalanceAmount, currency: record.currency },
      idempotentReplay: true,
      ...(record.failureCode ? { failureCode: record.failureCode } : {}),
    };
  }
}
