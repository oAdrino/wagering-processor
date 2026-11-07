import { UseGuards } from '@nestjs/common';
import { ProviderAuthGuard } from './provider-auth.guard';
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ProcessBetUseCase,
  type ProcessBetResult,
} from '../../application/use-cases/process-bet.use-case';
import { ProcessOtherWagerUseCase } from '../../application/use-cases/process-other-wager.use-case';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/entities/wager-transaction';

@UseGuards(ProviderAuthGuard)
@Controller('wagering')
export class WageringController {
  constructor(
    private readonly processBet: ProcessBetUseCase,
    private readonly processOtherWager: ProcessOtherWagerUseCase,
  ) {}

  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProcessBetResult> {
    const kind = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).kind
      : undefined;

    const result = kind === WagerTransactionKind.Bet
      ? await this.processBet.execute(body, idempotencyKey)
      : await this.processOtherWager.execute(body, idempotencyKey);

    if (result.status === WagerTransactionStatus.Rejected) {
      throw new HttpException(result, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (result.status === WagerTransactionStatus.PendingReference ||
        result.status === WagerTransactionStatus.Pending) {
      response.status(HttpStatus.ACCEPTED);
    }
    return result;
  }
}
