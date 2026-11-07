import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';

const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT || 'http://127.0.0.1:4566',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
});

async function main(): Promise<void> {
  try {
    const dlq = await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-transactions-dlq.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    if (!dlq.QueueUrl) throw new Error('Falha ao criar DLQ');
    const attrs = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl,
      AttributeNames: ['QueueArn'],
    }));
    const arn = attrs.Attributes?.QueueArn;
    if (!arn) throw new Error('A DLQ não retornou QueueArn');
    await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-transactions.fifo',
      Attributes: {
        FifoQueue: 'true', ContentBasedDeduplication: 'false',
        VisibilityTimeout: '45',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: '5' }),
      },
    }));
    await sqs.send(new CreateQueueCommand({
      QueueName: 'wager-events.fifo',
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }));
    console.log('Filas criadas: wager-transactions.fifo, wager-transactions-dlq.fifo, wager-events.fifo');
  } finally {
    sqs.destroy();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
