import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  GetQueueUrlCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

export const WAGER_QUEUE = 'wager-transactions.fifo';
export const DLQ_QUEUE = 'wager-transactions-dlq.fifo';
export const EVENT_QUEUE = 'wager-events.fifo';

@Injectable()
export class SqsClientService implements OnModuleDestroy {
  readonly client = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT || 'http://127.0.0.1:4566',
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
    },
    maxAttempts: 2,
  });

  async queueUrl(name: string): Promise<string> {
    const answer = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!answer.QueueUrl) throw new Error(`Fila SQS ${name} não encontrada; rode bun run infra:sqs`);
    return answer.QueueUrl;
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
