import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { EntityManager as SqlEntityManager } from '@mikro-orm/postgresql';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { SqsClientService, EVENT_QUEUE } from '../../infrastructure/messaging/sqs-client.service';

interface DueOutbox {
  id: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<number>;
  private stopping = false;
  private queue?: string;

  constructor(private readonly orm: MikroORM, private readonly sqs: SqsClientService) {}

  onModuleInit(): void {
    if (process.env.SQS_ENABLED !== '1') return;
    this.timer = setInterval(() => {
      if (!this.inFlight && !this.stopping) {
        const run = this.runOnce();
        this.inFlight = run;
        void run.catch((error: unknown) => this.logger.error(String(error)))
          .finally(() => { this.inFlight = undefined; });
      }
    }, 1000);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }

  /** PostgreSQL trava apenas as linhas selecionadas, com SKIP LOCKED entre publishers. */
  async runOnce(): Promise<number> {
    this.queue ??= await this.sqs.queueUrl(EVENT_QUEUE);
    return this.orm.em.fork().transactional(async (em) => {
      const sqlEm = em as SqlEntityManager;
      const rows = await sqlEm.execute<DueOutbox[]>(`
        select id, aggregate_id, payload, attempts
        from outbox_messages
        where published_at is null and (next_attempt_at is null or next_attempt_at <= now())
        order by occurred_at, id
        for update skip locked
        limit 10
      `);
      let sent = 0;
      for (const row of rows) {
        try {
          const data = row.payload.data as Record<string, unknown> | undefined;
          await this.sqs.client.send(new SendMessageCommand({
            QueueUrl: this.queue,
            MessageBody: JSON.stringify(row.payload),
            MessageGroupId: String(data?.walletId || row.aggregate_id),
            MessageDeduplicationId: row.id,
          }));
          // Só marco como publicado depois da confirmação do SQS.
          // Se cair nesse intervalo, reenviar o mesmo eventId é o comportamento esperado.
          await sqlEm.execute(
            'update outbox_messages set published_at = now(), next_attempt_at = null where id = ?', [row.id],
          );
          sent++;
        } catch (error) {
          const delay = Math.min(5 * (2 ** Math.min(row.attempts, 8)), 300);
          await sqlEm.execute(
            `update outbox_messages set attempts = attempts + 1,
             next_attempt_at = now() + (? * interval '1 second') where id = ?`,
            [delay, row.id],
          );
          this.logger.error(JSON.stringify({ event: 'outbox.retry', eventId: row.id, error: String(error) }));
        }
      }
      return sent;
    }, { clear: true });
  }
}
