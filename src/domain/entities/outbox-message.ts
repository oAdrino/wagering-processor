export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Modelo de domínio; persistence & claim concurrent via PostgreSQL. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}
  static enqueue(event: { eventId: string; aggregateId: string; eventType: string;
    occurredAt: Date; toJSON(): Record<string, unknown> }): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType,
      Object.freeze(event.toJSON()), new Date(event.occurredAt), 0);
  }
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state.id, state.aggregateId, state.eventType,
      state.payload, new Date(state.occurredAt), state.attempts,
      state.nextAttemptAt && new Date(state.nextAttemptAt),
      state.publishedAt && new Date(state.publishedAt));
  }
  get attempts() { return this._attempts; }
  get nextAttemptAt() { return this._nextAttemptAt && new Date(this._nextAttemptAt); }
  get publishedAt() { return this._publishedAt && new Date(this._publishedAt); }
  isPending() { return !this._publishedAt; }
  isDue(now: Date) { return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now); }
  markPublished(at: Date) {
    if (!this.isPending()) throw new Error('Evento já publicado');
    this._publishedAt = new Date(at);
  }
  scheduleRetry(now: Date) {
    if (!this.isPending()) throw new Error('Evento já publicado');
    this._attempts++;
    this._nextAttemptAt = new Date(now.getTime() + Math.min(5_000 * 2 ** (this._attempts - 1), 300_000));
  }
}
