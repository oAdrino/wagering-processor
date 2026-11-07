import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestLoggingInterceptor } from './infrastructure/messaging/request-logging.interceptor';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from '../mikro-orm.config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WalletsModule } from './wallets.module';
import { WageringModule } from './wagering.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), WalletsModule, WageringModule, MessagingModule],
  controllers: [AppController],
  providers: [AppService, { provide: APP_INTERCEPTOR, useClass: RequestLoggingInterceptor }],
})
export class AppModule {}
