
    
  
import { Migration } from '@mikro-orm/migrations';

export class Migration20261107133508 extends Migration {
  override name = 'Migration20261107133508';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(128) not null, "external_transaction_id" varchar(255) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(255) not null, "game_id" varchar(255) not null, "kind" varchar(12) not null, "money_amount" numeric(38,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(255) null, "reference_transaction_id" uuid null, "status" varchar(20) not null, "failure_code" varchar(64) null, "created_at" timestamptz not null, "processed_at" timestamptz null, "result_balance_amount" numeric(38,2) null, "attempts" int not null default 0, "next_attempt_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "idx_wager_wallet_created" on "wager_transactions" ("wallet_id", "created_at", "id");`);
    this.addSql(`create index "idx_wager_pending_references" on "wager_transactions" ("status", "next_attempt_at");`);
    this.addSql(`alter table "wager_transactions" add constraint "uq_wager_provider_external" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "uq_wager_provider_idempotency" unique ("provider_id", "idempotency_key");`);
    this.addSql(`create unique index "uq_wager_active_reversal" on "wager_transactions" ("provider_id", "reference_external_transaction_id", "kind") where kind IN ('REFUND', 'ROLLBACK') AND status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED');`);

    // Não remover o trigger de imutabilidade instalado pela migration anterior.
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id") on delete restrict;`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transactions" ("id") on delete restrict;`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_kind" check (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_status" check (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_amount" check (money_amount >= 0 AND (kind = 'LOSS' OR money_amount > 0));`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_attempts" check (attempts >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_reference_required" check (kind NOT IN ('REFUND', 'ROLLBACK') OR NULLIF(BTRIM(reference_external_transaction_id), '') IS NOT NULL);`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_processed_reference" check (status <> 'PROCESSED' OR kind NOT IN ('REFUND', 'ROLLBACK') OR reference_transaction_id IS NOT NULL);`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_failure_code" check (status NOT IN ('REJECTED', 'FAILED') OR failure_code IS NOT NULL);`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_processed_at" check (status <> 'PROCESSED' OR processed_at IS NOT NULL);`);
    this.addSql(`alter table "wager_transactions" add constraint "chk_wager_result_balance_non_negative" check (result_balance_amount IS NULL OR result_balance_amount >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop constraint "wager_transactions_reference_transaction_id_foreign";`);
    this.addSql(`alter table "wallet_ledger_entries" drop constraint "wallet_ledger_entries_transaction_id_foreign";`);
    this.addSql(`drop table if exists "wager_transactions";`);

  }
}