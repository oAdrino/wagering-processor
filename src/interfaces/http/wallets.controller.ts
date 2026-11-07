import { UseGuards } from '@nestjs/common';
import { ProviderAuthGuard } from './provider-auth.guard';
import { Body, Controller, Post } from '@nestjs/common';
import {
  CreateWalletUseCase,
  type CreateWalletInput,
  type CreateWalletResult,
} from '../../application/use-cases/create-wallet.use-case';

@UseGuards(ProviderAuthGuard)
@Controller('wallets')
export class WalletsController {
  constructor(private readonly createWallet: CreateWalletUseCase) {}

  @Post()
  create(@Body() input: CreateWalletInput): Promise<CreateWalletResult> {
    return this.createWallet.execute(input);
  }
}
