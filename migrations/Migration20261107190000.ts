import { Migration } from '@mikro-orm/migrations';

/** Inbox persistente e outbox atômica. Triggers pertencem às migrations, não ao schema generator. */
export class Migration20261107190000 extends Migration {
  override name = 'Migration20261107190000';

  override up(): void {
    this.addSql(`create table "inbox_messages" (
      "consumer_name" varchar(128) not null,
      "message_id" varchar(255) not null,
      "payload_hash" varchar(64) not null,
      "received_at" timestamptz not null default now(),
      "processed_at" timestamptz not null default now(),
      primary key ("consumer_name", "message_id")
    );`);
    this.addSql(`create table "outbox_messages" (
      "id" uuid not null primary key,
      "aggregate_id" uuid not null,
      "event_type" varchar(80) not null,
      "payload" jsonb not null,
      "occurred_at" timestamptz not null default now(),
      "attempts" int not null default 0,
      "next_attempt_at" timestamptz null,
      "published_at" timestamptz null,
      constraint "chk_outbox_attempts" check (attempts >= 0),
      constraint "uq_outbox_transaction_event" unique (aggregate_id, event_type)
    );`);
    this.addSql(`create index "idx_outbox_due" on "outbox_messages" ("next_attempt_at", "occurred_at") where "published_at" is null;`);

    // Eventos sobre Wager: insert de estado conhecido ou mudança posterior PENDING_REFERENCE -> terminal.
    // O trigger roda dentro da transação SQL de negócio; se ela falhar, nenhum evento permanece.
    this.addSql(`create function enqueue_wager_transaction_event() returns trigger as $$
      declare
        event_name text;
        event_id uuid := gen_random_uuid();
        event_time timestamptz := clock_timestamp();
      begin
        if tg_op = 'UPDATE' and new.status = old.status then return new; end if;
        event_name := case new.status
          when 'PROCESSED' then 'WagerTransactionProcessed'
          when 'REJECTED' then 'WagerTransactionRejected'
          when 'PENDING_REFERENCE' then 'WagerTransactionPendingReference'
          else null end;
        if event_name is null then return new; end if;
        insert into outbox_messages (id, aggregate_id, event_type, occurred_at, payload)
        values (event_id, new.id, event_name, event_time,
          jsonb_build_object(
            'eventId', event_id, 'eventType', event_name,
            'aggregateId', new.id, 'correlationId', new.id,
            'causationId', new.external_transaction_id,
            'occurredAt', event_time, 'version', 1,
            'data', jsonb_build_object(
              'transactionId', new.id, 'providerId', new.provider_id,
              'walletId', new.wallet_id, 'kind', new.kind, 'status', new.status,
              'failureCode', new.failure_code,
              'money', jsonb_build_object('amount', new.money_amount::text, 'currency', new.currency)
            )
          )) on conflict (aggregate_id, event_type) do nothing;
        return new;
      end;
    $$ language plpgsql;`);
    this.addSql(`create trigger "trg_wager_outbox_insert" after insert on "wager_transactions"
      for each row execute function enqueue_wager_transaction_event();`);
    this.addSql(`create trigger "trg_wager_outbox_update" after update of status on "wager_transactions"
      for each row execute function enqueue_wager_transaction_event();`);

    // Evento de saldo nasce da inserção do ledger, nunca apenas do UPDATE da wallet.
    this.addSql(`create function enqueue_wallet_balance_changed() returns trigger as $$
      declare
        event_id uuid := gen_random_uuid();
        event_time timestamptz := clock_timestamp();
        wallet_version int;
      begin
        select version into wallet_version from wallets where id = new.wallet_id;
        insert into outbox_messages (id, aggregate_id, event_type, occurred_at, payload)
        values (event_id, new.transaction_id, 'WalletBalanceChanged', event_time,
          jsonb_build_object(
            'eventId', event_id, 'eventType', 'WalletBalanceChanged',
            'aggregateId', new.wallet_id, 'correlationId', new.transaction_id,
            'causationId', new.transaction_id,
            'occurredAt', event_time, 'version', 1,
            'data', jsonb_build_object(
              'walletId', new.wallet_id, 'transactionId', new.transaction_id,
              'direction', new.direction,
              'money', jsonb_build_object('amount', new.money_amount::text, 'currency', new.currency),
              'balanceBefore', jsonb_build_object('amount', new.balance_before_amount::text, 'currency', new.currency),
              'balanceAfter', jsonb_build_object('amount', new.balance_after_amount::text, 'currency', new.currency),
              'walletVersion', wallet_version
            )
          ));
        return new;
      end;
    $$ language plpgsql;`);
    this.addSql(`create trigger "trg_ledger_balance_outbox" after insert on "wallet_ledger_entries"
      for each row execute function enqueue_wallet_balance_changed();`);
  }

  override down(): void {
    this.addSql(`drop trigger if exists "trg_ledger_balance_outbox" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists enqueue_wallet_balance_changed();`);
    this.addSql(`drop trigger if exists "trg_wager_outbox_update" on "wager_transactions";`);
    this.addSql(`drop trigger if exists "trg_wager_outbox_insert" on "wager_transactions";`);
    this.addSql(`drop function if exists enqueue_wager_transaction_event();`);
    this.addSql(`drop table if exists "outbox_messages";`);
    this.addSql(`drop table if exists "inbox_messages";`);
  }
}
