
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

import { WalletLedgerEntryRecordSchema } from './src/infrastructure/database/entities/wallet-ledger-entry.record';



import { WalletRecordSchema } from
  './src/infrastructure/database/entities/wallet.record.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL não configurada');
}

export default defineConfig({
  clientUrl: databaseUrl,

  entities: [
    WalletRecordSchema,
    WalletLedgerEntryRecordSchema,
  ],

  extensions: [Migrator],

  migrations: {
    path: './migrations',
    emit: 'ts',
    transactional: true,
  },
});
