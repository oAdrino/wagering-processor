import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';
import { CreateWalletUseCase } from '../src/application/use-cases/create-wallet.use-case';
import { ProcessBetUseCase } from '../src/application/use-cases/process-bet.use-case';
import { ProcessOtherWagerUseCase } from '../src/application/use-cases/process-other-wager.use-case';
import { SqsInboxWorker } from '../src/application/workers/sqs-inbox.worker';
import { OutboxPublisherWorker } from '../src/application/workers/outbox-publisher.worker';
import { SqsClientService, WAGER_QUEUE } from '../src/infrastructure/messaging/sqs-client.service';
import { WagerTransactionKind } from '../src/domain/entities/wager-transaction';

const suite = process.env.RUN_SQS_TESTS === '1' ? describe : describe.skip;
suite('Mensageria SQS real (MiniStack)', () => {
  let orm: MikroORM;
  let sqs: SqsClientService;
  let inbox: SqsInboxWorker;
  let outbox: OutboxPublisherWorker;
  let wallets: CreateWalletUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    sqs = new SqsClientService();
    inbox = new SqsInboxWorker(sqs, new ProcessBetUseCase(orm), new ProcessOtherWagerUseCase(orm));
    outbox = new OutboxPublisherWorker(orm, sqs);
    wallets = new CreateWalletUseCase(orm);
  });
  afterAll(async () => { sqs.onModuleDestroy(); if (orm) await orm.close(); });

  test('Mensagem SQS duplicada é reconhecida por idempotência e Inbox', async () => {
    const playerId = randomUUID();
    const wallet = await wallets.execute({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } });
    const transaction = randomUUID();
    const message = {
      messageId: randomUUID(), type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-sqs', externalTransactionId: transaction,
        idempotencyKey: `provider-sqs:${transaction}`, playerId, walletId: wallet.id,
        roundId: randomUUID(), gameId: 'test', kind: WagerTransactionKind.Bet,
        money: { amount: '40.00', currency: 'BRL' },
      },
    };
    const queue = await sqs.queueUrl(WAGER_QUEUE);
    const send = async () => sqs.client.send(new SendMessageCommand({
      QueueUrl: queue, MessageGroupId: wallet.id, MessageDeduplicationId: randomUUID(),
      MessageBody: JSON.stringify(message),
    }));
    await send();
    await inbox.runOnce();
    await send();
    await inbox.runOnce();
    const rows = await orm.em.fork().getConnection().execute<{balance_amount: string}[]>(
      'select balance_amount from wallets where id = ?', [wallet.id],
    );
    expect(rows[0].balance_amount).toBe('60.00');
    // Mesmo payload + messageId gera somente um registro de Inbox.
    const received = await orm.em.fork().getConnection().execute<{c: string}[]>(
      'select count(*)::text as c from inbox_messages where message_id = ?', [message.messageId],
    );
    expect(received[0].c).toBe('1');
  }, 90000);

  test('Publisher envia os eventos confirmados para o SQS', async () => {
    const before = await orm.em.fork().getConnection().execute<{c: string}[]>(
      'select count(*)::text as c from outbox_messages where published_at is null',
    );
    expect(Number(before[0].c)).toBeGreaterThan(0);
    const result = await outbox.runOnce();
    expect(result).toBeGreaterThan(0);
  }, 90000);
});
