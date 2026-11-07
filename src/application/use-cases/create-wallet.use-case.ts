import { randomUUID, createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { MikroORM, UniqueConstraintViolationException } from '@mikro-orm/core';

import { Wallet } from '../../domain/entities/wallet';
import { Money, InvalidMoneyError, type MoneyProps } from '../../domain/value-objects/money';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction';
import {
  WalletLedgerEntry,
  LedgerDirection,
} from '../../domain/entities/wallet-ledger-entry';
import { WalletRecord } from '../../infrastructure/database/entities/wallet.record';
import { WagerTransactionRecord } from '../../infrastructure/database/entities/wager-transaction.record';
import { WalletLedgerEntryRecord } from '../../infrastructure/database/entities/wallet-ledger-entry.record';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(private readonly orm: MikroORM) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    if (
      typeof input?.playerId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.playerId)
    ) {
      throw new BadRequestException('playerId deve ser um UUID válido');
    }

    let openingBalance: Money;
    try {
      openingBalance = Money.from(input.initialBalance);
    } catch (error) {
      if (error instanceof InvalidMoneyError || error instanceof TypeError) {
        throw new BadRequestException('initialBalance inválido');
      }
      throw error;
    }

    // Escopo simplificado explicitamente permitido pelo desafio.
    if (openingBalance.currency !== 'BRL') {
      throw new BadRequestException('A API aceita somente BRL');
    }

    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      initialBalance: openingBalance,
    });

    try {
      // Carteira, abertura e ledger precisam existir juntos. Se uma gravação falhar,
      // a transação SQL desfaz as demais.
      await this.orm.em.fork().transactional(async (em) => {
        const walletRecord = em.create(WalletRecord, {
          id: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balanceAmount: wallet.balance.toJSON().amount,
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });

        // Saldo inicial zero não gera OPENING nem lançamento financeiro.
        if (openingBalance.isZero()) return;

        const txId = randomUUID();
        const externalTransactionId = `opening:${wallet.id}`;
        const providerId = 'internal';
        const canonicalData = JSON.stringify({
          walletId: wallet.id,
          playerId: wallet.playerId,
          amount: openingBalance.toJSON().amount,
          currency: openingBalance.currency,
        });
        const payloadHash = createHash('sha256').update(canonicalData).digest('hex');

        const opening = WagerTransaction.create({
          id: txId,
          providerId,
          externalTransactionId,
          idempotencyKey: `${providerId}:${externalTransactionId}`,
          payloadHash,
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: `opening:${wallet.id}`,
          gameId: 'internal',
          kind: WagerTransactionKind.Opening,
          money: openingBalance,
        });
        opening.markProcessed(undefined, new Date());

        const transactionRecord = em.create(WagerTransactionRecord, {
          id: opening.id,
          providerId: opening.providerId,
          externalTransactionId: opening.externalTransactionId,
          idempotencyKey: opening.idempotencyKey,
          payloadHash: opening.payloadHash,
          wallet: walletRecord,
          playerId: opening.playerId,
          roundId: opening.roundId,
          gameId: opening.gameId,
          kind: opening.kind,
          moneyAmount: opening.money.toJSON().amount,
          currency: opening.money.currency,
          status: opening.status,
          createdAt: opening.createdAt,
          processedAt: opening.processedAt,
          resultBalanceAmount: openingBalance.toJSON().amount,
          attempts: 0,
        });

        const ledger = WalletLedgerEntry.create({
          id: randomUUID(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: openingBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: openingBalance,
        });

        em.create(WalletLedgerEntryRecord, {
          id: ledger.id,
          wallet: walletRecord,
          transaction: transactionRecord,
          direction: ledger.direction,
          moneyAmount: ledger.money.toJSON().amount,
          currency: ledger.money.currency,
          balanceBeforeAmount: ledger.balanceBefore.toJSON().amount,
          balanceAfterAmount: ledger.balanceAfter.toJSON().amount,
          createdAt: ledger.createdAt,
        });
      }, { clear: true });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictException('Já existe uma wallet para esse jogador e moeda');
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}
