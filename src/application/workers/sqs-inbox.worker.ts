import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { ProcessBetUseCase } from '../use-cases/process-bet.use-case';
import { ProcessOtherWagerUseCase } from '../use-cases/process-other-wager.use-case';
import { WagerTransactionKind } from '../../domain/entities/wager-transaction';
import { SqsClientService, WAGER_QUEUE } from '../../infrastructure/messaging/sqs-client.service';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, canonicalize(val)]));
  }
  return value;
}

/** Assinatura de transporte da seção 10 do desafio. */
function parseMessage(raw: string): {
  messageId: string;
  data: Record<string, unknown>;
  idempotencyKey: string;
  payloadHash: string;
} {
  const message: unknown = JSON.parse(raw);
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Envelope deve ser um objeto');
  }
  const envelope = message as Record<string, unknown>;
  if (envelope.type !== 'WagerTransactionRequested' ||
      typeof envelope.messageId !== 'string' || !envelope.messageId || envelope.messageId.length > 255 ||
      !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
    throw new Error('Envelope SQS inválido');
  }
  const { idempotencyKey, ...data } = envelope.data as Record<string, unknown>;
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
    throw new Error('Idempotency-Key ausente na mensagem SQS');
  }
  return {
    messageId: envelope.messageId,
    data,
    idempotencyKey,
    payloadHash: createHash('sha256')
      .update(JSON.stringify(canonicalize(envelope.data))).digest('hex'),
  };
}

@Injectable()
export class SqsInboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsInboxWorker.name);
  private stopping = false;
  private running?: Promise<void>;
  private queue?: string;

  constructor(
    private readonly sqs: SqsClientService,
    private readonly processBet: ProcessBetUseCase,
    private readonly processOther: ProcessOtherWagerUseCase,
  ) {}

  onModuleInit(): void {
    if (process.env.SQS_ENABLED === '1') this.running = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.running;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error(JSON.stringify({ event: 'sqs.receive.error', error: String(error) }));
        await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      }
    }
  }

  /** Executa um lote, sem timer, para testes de integração determinísticos. */
  async runOnce(): Promise<number> {
    this.queue ??= await this.sqs.queueUrl(WAGER_QUEUE);
    const batch = await this.sqs.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queue, MaxNumberOfMessages: 5,
      WaitTimeSeconds: 2, VisibilityTimeout: 45,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }));
    for (const message of batch.Messages ?? []) {
      if (this.stopping) await this.restoreVisibility(message);
      else await this.handle(message);
    }
    return batch.Messages?.length ?? 0;
  }

  private async restoreVisibility(message: Message): Promise<void> {
    if (this.queue && message.ReceiptHandle) {
      await this.sqs.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.queue, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: 0,
      }));
    }
  }

  /** Ack somente após o caso de uso terminar COMMIT (inclui Inbox). */
  private async handle(message: Message): Promise<void> {
    if (!this.queue || !message.Body || !message.ReceiptHandle) return;
    try {
      const parsed = parseMessage(message.Body);
      const receipt = {
        consumerName: 'wager-processor',
        messageId: parsed.messageId,
        payloadHash: parsed.payloadHash,
      };
      if (parsed.data.kind === WagerTransactionKind.Bet) {
        await this.processBet.execute(parsed.data, parsed.idempotencyKey, receipt);
      } else {
        await this.processOther.execute(parsed.data, parsed.idempotencyKey, receipt);
      }
      // Só removo a mensagem da fila após o caso de uso confirmar a gravação.
      // Se falhar antes, a mensagem volta e a Inbox protege contra duplicações.
      await this.sqs.client.send(new DeleteMessageCommand({
        QueueUrl: this.queue, ReceiptHandle: message.ReceiptHandle,
      }));
    } catch (error) {
      const attempts = Number(message.Attributes?.ApproximateReceiveCount || 1);
      this.logger.error(JSON.stringify({
        event: 'sqs.process.error', sqsMessageId: message.MessageId, attempts,
        error: String(error),
      }));
      // Não ack: recebe novamente e a redrive policy envia à DLQ após 5 recebimentos.
      // Retry exponencial limitado, inclusive para erros permanentes (DLQ).
      await this.sqs.client.send(new ChangeMessageVisibilityCommand({
        QueueUrl: this.queue,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: Math.min(5 * 2 ** Math.max(0, attempts - 1), 60),
      }));
    }
  }
}
