import { Controller, Get, HttpException, HttpStatus, Header } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { SqsClientService, DLQ_QUEUE, EVENT_QUEUE, WAGER_QUEUE } from '../../infrastructure/messaging/sqs-client.service';

@Controller()
export class HealthController {
  constructor(private readonly orm: MikroORM, private readonly sqs: SqsClientService) {}

  @Get('health/live')
  live() { return { status: 'ok' }; }

  @Get('health/ready')
  async ready() {
    const checks = { postgres: false, sqs: false };
    try {
      await this.orm.em.fork().getConnection().execute('select 1');
      checks.postgres = true;
    } catch { /* readiness deve falhar */ }
    try {
      await Promise.all([this.sqs.queueUrl(WAGER_QUEUE), this.sqs.queueUrl(EVENT_QUEUE)]);
      checks.sqs = true;
    } catch { /* readiness deve falhar */ }
    if (!checks.postgres || !checks.sqs) {
      throw new HttpException({ status: 'unavailable', checks }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return { status: 'ok', checks };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async metrics(): Promise<string> {
    const connection = this.orm.em.fork().getConnection();
    const statuses = await connection.execute<{status: string; count: string}[]>(
      'select status, count(*)::text as count from wager_transactions group by status',
    );
    const [outbox] = await connection.execute<{
      pending: string; lag_seconds: string; retries: string;
    }[]>(`select
      count(*) filter (where published_at is null)::text as pending,
      coalesce(extract(epoch from now() - min(occurred_at) filter (where published_at is null)), 0)::text as lag_seconds,
      coalesce(sum(attempts), 0)::text as retries from outbox_messages`);
    const [inbox] = await connection.execute<{count: string}[]>(
      'select count(*)::text as count from inbox_messages',
    );
    // Métricas de estado persistido funcionam com várias instâncias.
    const lines = [
      '# HELP wager_transactions_total Total de transações por status',
      '# TYPE wager_transactions_total gauge',
      ...statuses.map((s: { status: string; count: string }) => `wager_transactions_total{status="${s.status}"} ${s.count}`),
      '# TYPE wager_outbox_pending gauge',
      `wager_outbox_pending ${outbox.pending}`,
      '# TYPE wager_outbox_lag_seconds gauge',
      `wager_outbox_lag_seconds ${outbox.lag_seconds}`,
      '# TYPE wager_outbox_retries_total gauge',
      `wager_outbox_retries_total ${outbox.retries}`,
      '# TYPE wager_inbox_processed_total gauge',
      `wager_inbox_processed_total ${inbox.count}`,
    ];
    try {
      const dlq = await this.sqs.queueUrl(DLQ_QUEUE);
      const attrs = await this.sqs.client.send(new GetQueueAttributesCommand({
        QueueUrl: dlq, AttributeNames: ['ApproximateNumberOfMessages'],
      }));
      lines.push('# TYPE wager_dlq_visible_messages gauge');
      lines.push(`wager_dlq_visible_messages ${attrs.Attributes?.ApproximateNumberOfMessages ?? 0}`);
    } catch {
      lines.push('# DLQ metrics unavailable');
    }
    return `${lines.join('\n')}\n`;
  }
}
