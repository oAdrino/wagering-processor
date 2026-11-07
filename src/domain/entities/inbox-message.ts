export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}
export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/** Idempotência de entrega SQS (diferente da Idempotency-Key de negócio). */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId.trim() || !props.consumerName.trim() ||
      !/^[a-f\d]{64}$/i.test(props.payloadHash)) {
      throw new Error('Mensagem Inbox inválida');
    }
    return new InboxMessage(props.messageId, props.consumerName,
      props.payloadHash, props.receivedAt ?? new Date());
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash,
      new Date(state.receivedAt!), state.processedAt ? new Date(state.processedAt) : undefined);
  }

  get processedAt(): Date | undefined {
    return this._processedAt && new Date(this._processedAt);
  }
  isProcessed(): boolean { return Boolean(this._processedAt); }
  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new Error('Inbox já processada');
    this._processedAt = new Date(at);
  }
}
