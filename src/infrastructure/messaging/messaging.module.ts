import { Module } from '@nestjs/common';
import { SqsClientService } from './sqs-client.service';
import { SqsInboxWorker } from '../../application/workers/sqs-inbox.worker';
import { OutboxPublisherWorker } from '../../application/workers/outbox-publisher.worker';
import { WageringModule } from '../../wagering.module';
import { HealthController } from '../../interfaces/http/health.controller';
import { QueriesController } from '../../interfaces/http/queries.controller';
import { ProviderAuthGuard } from '../../interfaces/http/provider-auth.guard';

@Module({
  imports: [WageringModule],
  controllers: [HealthController, QueriesController],
  providers: [SqsClientService, SqsInboxWorker, OutboxPublisherWorker, ProviderAuthGuard],
  exports: [SqsClientService],
})
export class MessagingModule {}
