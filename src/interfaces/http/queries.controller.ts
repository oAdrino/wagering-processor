import { UseGuards } from '@nestjs/common';
import { ProviderAuthGuard } from './provider-auth.guard';
import { Buffer } from 'node:buffer';
import { Controller, Get, NotFoundException, Param, Post, Query, BadRequestException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { EntityManager as SqlEntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/value-objects/money';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(id: string): string {
  if (!UUID.test(id)) throw new BadRequestException('Identificador UUID inválido');
  return id;
}

type WalletRow = {
  id: string; player_id: string; currency: string;
  balance_amount: string; version: number;
};
type LedgerRow = {
  id: string; transaction_id: string; direction: string; money_amount: string;
  currency: string; balance_before_amount: string; balance_after_amount: string;
  created_at: Date | string;
};
type WagerRow = {
  id: string; provider_id: string; external_transaction_id: string;
  wallet_id: string; kind: string; status: string; failure_code: string | null;
  money_amount: string; currency: string; result_balance_amount: string | null;
};

@UseGuards(ProviderAuthGuard)
@Controller()
export class QueriesController {
  constructor(private readonly orm: MikroORM) {}

  @Get('wallets/:walletId')
  async wallet(@Param('walletId') walletId: string) {
    const rows = await this.orm.em.fork().getConnection().execute<WalletRow[]>(
      'select id, player_id, currency, balance_amount, version from wallets where id = ?',
      [uuid(walletId)],
    );
    const w = rows[0];
    if (!w) throw new NotFoundException('Wallet não encontrada');
    return {
      id: w.id, playerId: w.player_id, version: w.version,
      balance: { amount: w.balance_amount, currency: w.currency },
    };
  }

  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    uuid(walletId);
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit deve estar entre 1 e 100');
    }
    let before: { createdAt: string; id: string } | undefined;
    if (cursor) {
      try {
        if (cursor.length > 1000) throw new Error('cursor longo');
        before = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!before || !UUID.test(before.id) || Number.isNaN(Date.parse(before.createdAt))) {
          throw new Error('cursor inválido');
        }
      } catch {
        throw new BadRequestException('cursor inválido');
      }
    }
    const rows = await this.orm.em.fork().getConnection().execute<LedgerRow[]>(`
      select id, transaction_id, direction, money_amount, currency,
        balance_before_amount, balance_after_amount, created_at
      from wallet_ledger_entries
      where wallet_id = ?
        ${before ? 'and (created_at, id) < (?::timestamptz, ?::uuid)' : ''}
      order by created_at desc, id desc
      limit ?
    `, before ? [walletId, before.createdAt, before.id, limit + 1] : [walletId, limit + 1]);
    // Busco limit + 1 para saber se há outra página sem fazer COUNT no ledger.
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const hasMore = rows.length > limit;
    return {
      items: page.map((r: LedgerRow) => ({
        id: r.id, transactionId: r.transaction_id, direction: r.direction,
        money: { amount: r.money_amount, currency: r.currency },
        balanceBefore: { amount: r.balance_before_amount, currency: r.currency },
        balanceAfter: { amount: r.balance_after_amount, currency: r.currency },
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({
        createdAt: new Date(last.created_at).toISOString(), id: last.id,
      })).toString('base64url') : null,
    };
  }

  @Post('wallets/:walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    uuid(walletId);
    // Snapshot consistente mesmo com outras operações concorrentes.
    return this.orm.em.fork().transactional(async (em) => {
      const sqlEm = em as SqlEntityManager;
      const wallet = await sqlEm.execute<WalletRow[]>(
        'select id, player_id, balance_amount, currency, version from wallets where id = ? for share',
        [walletId],
      );
      if (!wallet.length) throw new NotFoundException('Wallet não encontrada');
      const entry = await sqlEm.execute<{ calculated: string; count: string }[]>(`
        select coalesce(sum(case when direction = 'CREDIT' then money_amount else -money_amount end), 0)::numeric(38,2) as calculated,
          count(*)::text as count
        from wallet_ledger_entries where wallet_id = ?
      `, [walletId]);
      const stored = Money.from({ amount: wallet[0].balance_amount, currency: wallet[0].currency });
      // Não corrijo o saldo em uma reconciliação. Se houver diferença, ela deve
      // aparecer na resposta para investigação, sem esconder o problema.
      // O cálculo pode ser negativo, por isso trato o sinal separadamente.
      const calculatedAmount = entry[0].calculated;
      const absoluteCalculated = calculatedAmount.startsWith('-') ? calculatedAmount.slice(1) : calculatedAmount;
      const calculated = Money.from({ amount: absoluteCalculated, currency: wallet[0].currency });
      const signedCalculated = calculatedAmount.startsWith('-') ? calculated.negate() : calculated;
      const difference = stored.subtract(signedCalculated);
      const consistent = difference.isZero();
      if (!consistent) console.error(JSON.stringify({ event: 'reconciliation.divergence', walletId }));
      return {
        walletId, storedBalance: stored.toJSON(), calculatedBalance: signedCalculated.toJSON(),
        difference: difference.toJSON(), consistent, checkedEntries: Number(entry[0].count),
      };
    }, { clear: true });
  }

  @Get('wagering/transactions/:transactionId')
  async transaction(@Param('transactionId') transactionId: string) {
    const rows = await this.orm.em.fork().getConnection().execute<WagerRow[]>(`
      select id, provider_id, external_transaction_id, wallet_id, kind, status,
        failure_code, money_amount, currency, result_balance_amount
      from wager_transactions where id = ?
    `, [uuid(transactionId)]);
    return this.formatTransaction(rows[0]);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async externalTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const rows = await this.orm.em.fork().getConnection().execute<WagerRow[]>(`
      select id, provider_id, external_transaction_id, wallet_id, kind, status,
        failure_code, money_amount, currency, result_balance_amount
      from wager_transactions where provider_id = ? and external_transaction_id = ?
    `, [providerId, externalTransactionId]);
    return this.formatTransaction(rows[0]);
  }

  private formatTransaction(row?: WagerRow) {
    if (!row) throw new NotFoundException('Transação não encontrada');
    return {
      transactionId: row.id, providerId: row.provider_id,
      externalTransactionId: row.external_transaction_id, walletId: row.wallet_id,
      kind: row.kind, status: row.status, failureCode: row.failure_code,
      money: { amount: row.money_amount, currency: row.currency },
      balance: row.result_balance_amount === null ? null : {
        amount: row.result_balance_amount, currency: row.currency,
      },
    };
  }
}
