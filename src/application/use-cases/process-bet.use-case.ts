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

/** Entrada do processamento de BET; as outras operações têm um caso de uso separado. */
export interface ProcessBetInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind.Bet;
  money: MoneyProps;
}

export interface ProcessBetResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_FIELDS = [
  'providerId', 'externalTransactionId', 'playerId', 'walletId',
  'roundId', 'gameId', 'kind', 'money',
];

function parseBet(body: unknown): { input: ProcessBetInput; money: Money } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Payload deve ser um objeto JSON');
  }

  const request = body as Record<string, unknown>;
  if (Object.keys(request).some((key) => !REQUEST_FIELDS.includes(key))) {
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

  if (request.kind !== WagerTransactionKind.Bet) {
    throw new BadRequestException('Esta etapa da API implementa apenas BET');
  }

  if (!request.money || typeof request.money !== 'object' || Array.isArray(request.money)) {
    throw new BadRequestException('money deve ser um objeto');
  }

  const moneyObject = request.money as Record<string, unknown>;
  if (Object.keys(moneyObject).some((key) => !['amount', 'currency'].includes(key))) {
    throw new BadRequestException('money contém campos desconhecidos');
  }

  let money: Money;
  try {
    money = Money.from(moneyObject as unknown as MoneyProps);
  } catch (error) {
    if (error instanceof InvalidMoneyError || error instanceof TypeError) {
      throw new BadRequestException('money inválido: use string decimal com duas casas');
    }
    throw error;
  }

  // NUMERIC(38,2) suporta no máximo 36 dígitos inteiros.
  if (money.toJSON().amount.split('.')[0].length > 36) {
    throw new BadRequestException('Valor excede a capacidade do banco de dados');
  }

  if (!money.isPositive() || money.currency !== 'BRL') {
    throw new BadRequestException('BET deve ser positiva e utilizar BRL');
  }

  return {
    input: {
      providerId: request.providerId as string,
      externalTransactionId: request.externalTransactionId as string,
      playerId: request.playerId as string,
      walletId: request.walletId as string,
      roundId: request.roundId as string,
      gameId: request.gameId as string,
      kind: WagerTransactionKind.Bet,
      money: money.toJSON(),
    },
    money,
  };
}

/** Campos de negócio ordenados explicitamente; o header Idempotency-Key não participa do hash. */
export function canonicalBetHash(input: ProcessBetInput): string {
  const canonicalJson = JSON.stringify({
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: {
      amount: input.money.amount,
      currency: input.money.currency,
    },
    playerId: input.playerId,
    providerId: input.providerId,
    roundId: input.roundId,
    walletId: input.walletId,
  });

  return createHash('sha256').update(canonicalJson).digest('hex');
}

@Injectable()
export class ProcessBetUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(body: unknown, idempotencyKey: string | undefined, inbox?: InboxReceipt): Promise<ProcessBetResult> {
    if (typeof idempotencyKey !== 'string' ||
        !idempotencyKey.trim() || idempotencyKey.length > 255) {
      throw new BadRequestException('Header Idempotency-Key é obrigatório (máximo 255 caracteres)');
    }

    const { input, money } = parseBet(body);
    const payloadHash = canonicalBetHash(input);

    try {
      return await this.orm.em.fork().transactional(async (em) => {
        // Replays antigos podem ser respondidos antes de bloquear qualquer carteira.
        // Transações simultâneas são rechecadas depois do lock e protegidas pelo índice UNIQUE.
        const alreadyCommitted = await em.findOne(WagerTransactionRecord, {
          providerId: input.providerId,
          idempotencyKey,
        });
        if (alreadyCommitted) { await persistInbox(em, inbox); return this.replay(alreadyCommitted, payloadHash); }

        // Serializa somente operações da mesma carteira, inclusive entre processos diferentes.
        const walletRecord = await em.findOne(
          WalletRecord,
          { id: input.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!walletRecord) {
          throw new NotFoundException('Wallet não encontrada');
        }

        // Outra instância pode ter processado a mesma chave enquanto esperávamos o lock.
        // Por isso repito a consulta depois de bloquear a carteira.
        const previous = await em.findOne(WagerTransactionRecord, {
          providerId: input.providerId,
          idempotencyKey,
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
          id: walletRecord.id,
          playerId: walletRecord.playerId,
          currency: walletRecord.currency,
          balance: Money.from({
            amount: walletRecord.balanceAmount,
            currency: walletRecord.currency,
          }),
          version: walletRecord.version,
          createdAt: walletRecord.createdAt,
          updatedAt: walletRecord.updatedAt,
        });

        const wager = WagerTransaction.create({
          id: randomUUID(),
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          idempotencyKey,
          payloadHash,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: input.roundId,
          gameId: input.gameId,
          kind: WagerTransactionKind.Bet,
          money,
        });

        let movement: ReturnType<Wallet['debit']> | undefined;
        try {
          movement = wallet.debit(money);
          wager.markProcessed(undefined, new Date());
        } catch (error) {
          if (error instanceof InsufficientFundsError) {
            wager.reject(FailureCode.InsufficientFunds);
          } else {
            throw error;
          }
        }

        // Guardo o saldo desta resposta: num replay futuro a carteira já pode ter mudado.
        const balance = wallet.balance.toJSON();
        const wagerRecord = em.create(WagerTransactionRecord, {
          id: wager.id,
          providerId: wager.providerId,
          externalTransactionId: wager.externalTransactionId,
          idempotencyKey: wager.idempotencyKey,
          payloadHash: wager.payloadHash,
          wallet: walletRecord,
          playerId: wager.playerId,
          roundId: wager.roundId,
          gameId: wager.gameId,
          kind: wager.kind,
          moneyAmount: money.toJSON().amount,
          currency: money.currency,
          status: wager.status,
          failureCode: wager.failureCode,
          createdAt: wager.createdAt,
          processedAt: wager.processedAt,
          resultBalanceAmount: balance.amount,
          attempts: 0,
        });

        if (movement) {
          walletRecord.balanceAmount = balance.amount;
          walletRecord.version = wallet.version;
          walletRecord.updatedAt = wallet.updatedAt;

          const ledger = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: wager.id,
            direction: LedgerDirection.Debit,
            money,
            balanceBefore: movement.balanceBefore,
            balanceAfter: movement.balanceAfter,
          });

          em.create(WalletLedgerEntryRecord, {
            id: ledger.id,
            wallet: walletRecord,
            transaction: wagerRecord,
            direction: ledger.direction,
            moneyAmount: money.toJSON().amount,
            currency: money.currency,
            balanceBeforeAmount: ledger.balanceBefore.toJSON().amount,
            balanceAfterAmount: ledger.balanceAfter.toJSON().amount,
            createdAt: ledger.createdAt,
          });
        }

        await persistInbox(em, inbox);
        await em.flush();

        return {
          transactionId: wager.id,
          status: wager.status,
          balance,
          idempotentReplay: false,
          ...(wager.failureCode ? { failureCode: wager.failureCode } : {}),
        };
      }, { clear: true });
    } catch (error) {
      // Se a mesma chave disputa carteiras diferentes, a constraint única resolve a race.
      if (error instanceof UniqueConstraintViolationException) {
        const readEm = this.orm.em.fork();
        const previous = await readEm.findOne(WagerTransactionRecord, {
          providerId: input.providerId,
          idempotencyKey,
        });
        if (previous) return this.replay(previous, payloadHash);
        const external = await readEm.findOne(WagerTransactionRecord, {
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
        });
        if (external) {
          throw new ConflictException('externalTransactionId já utilizado por esse provedor');
        }
      }
      throw error;
    }
  }

  private replay(previous: WagerTransactionRecord, payloadHash: string): ProcessBetResult {
    if (previous.payloadHash !== payloadHash) {
      throw new ConflictException('Idempotency-Key reutilizada com payload diferente');
    }

    if (!previous.resultBalanceAmount) {
      throw new ConflictException('Transação anterior ainda não tem resultado final');
    }

    return {
      transactionId: previous.id,
      status: previous.status,
      balance: { amount: previous.resultBalanceAmount, currency: previous.currency },
      idempotentReplay: true,
      ...(previous.failureCode ? { failureCode: previous.failureCode } : {}),
    };
  }
}
