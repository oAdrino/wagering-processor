import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { WalletRecordSchema } from './src/infrastructure/database/entities/wallet.record';
import { WagerTransactionRecordSchema } from './src/infrastructure/database/entities/wager-transaction.record';
import { WalletLedgerEntryRecordSchema } from './src/infrastructure/database/entities/wallet-ledger-entry.record';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL não configurada');
}

export default defineConfig({
  clientUrl: databaseUrl,
  entities: [
    WalletRecordSchema,
    WagerTransactionRecordSchema,
    WalletLedgerEntryRecordSchema,
  ],
  extensions: [Migrator],
  schemaGenerator: {

    ignoreTriggers: true,
    ignoreRoutines: true,
  },
  migrations: {
    path: './migrations',
    emit: 'ts',
    transactional: true,
  },
});
