import { Migration } from '@mikro-orm/migrations';

export class Migration20261107024158 extends Migration {

  override name = 'Migration20261107024158';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" varchar(6) not null, "money_amount" numeric(38,2) not null, "currency" varchar(3) not null, "balance_before_amount" numeric(38,2) not null, "balance_after_amount" numeric(38,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "idx_ledger_wallet_created" on "wallet_ledger_entries" ("wallet_id", "created_at", "id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "uq_ledger_wallet_transaction" unique ("wallet_id", "transaction_id");`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_direction" check (direction IN ('DEBIT', 'CREDIT'));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_money_positive" check (money_amount > 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_balances_non_negative" check (balance_before_amount >= 0 AND balance_after_amount >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_arithmetic" check (
        (
          direction = 'CREDIT'
          AND balance_after_amount = balance_before_amount + money_amount
        )
        OR
        (
          direction = 'DEBIT'
          AND balance_after_amount = balance_before_amount - money_amount
        )
      );`);
    
    this.addSql(`
      CREATE FUNCTION forbid_wallet_ledger_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'wallet_ledger_entries is immutable';

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER trg_wallet_ledger_immutable
      BEFORE UPDATE OR DELETE OR TRUNCATE
      ON wallet_ledger_entries
      FOR EACH STATEMENT
      EXECUTE FUNCTION forbid_wallet_ledger_mutation();
    `);
      
  }

  
  override down(): void | Promise<void> {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_wallet_ledger_immutable
      ON wallet_ledger_entries;
    `);

    this.addSql(`
      DROP FUNCTION IF EXISTS forbid_wallet_ledger_mutation();
    `);

    this.addSql(`
      DROP TABLE IF EXISTS wallet_ledger_entries;
    `);
  }
}
