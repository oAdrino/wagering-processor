import { Module } from '@nestjs/common';
import { CreateWalletUseCase } from './application/use-cases/create-wallet.use-case';
import { WalletsController } from './interfaces/http/wallets.controller';
import { ProviderAuthGuard } from './interfaces/http/provider-auth.guard';

@Module({
  controllers: [WalletsController],
  providers: [CreateWalletUseCase, ProviderAuthGuard],
})
export class WalletsModule {}
