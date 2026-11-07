import { Module } from '@nestjs/common';
import { ProcessBetUseCase } from './application/use-cases/process-bet.use-case';
import { ProcessOtherWagerUseCase } from './application/use-cases/process-other-wager.use-case';
import { WageringController } from './interfaces/http/wagering.controller';
import { PendingReferenceWorker } from './application/workers/pending-reference.worker';
import { ProviderAuthGuard } from './interfaces/http/provider-auth.guard';

@Module({
  controllers: [WageringController],
  providers: [ProcessBetUseCase, ProcessOtherWagerUseCase, PendingReferenceWorker, ProviderAuthGuard],
  exports: [ProcessBetUseCase, ProcessOtherWagerUseCase],
})
export class WageringModule {}
