export interface BaileysContextInfoLike {
  readonly stanzaId?: string | null;
}

export interface BaileysTextMessageLike {
  readonly text?: string | null;
  readonly contextInfo?: BaileysContextInfoLike | null;
}

export interface BaileysMediaMessageLike {
  readonly caption?: string | null;
  readonly mimetype?: string | null;
  readonly fileName?: string | null;
  readonly contextInfo?: BaileysContextInfoLike | null;
}

export interface BaileysMessageContentLike {
  readonly conversation?: string | null;
  readonly extendedTextMessage?: BaileysTextMessageLike | null;
  readonly imageMessage?: BaileysMediaMessageLike | null;
  readonly videoMessage?: BaileysMediaMessageLike | null;
  readonly audioMessage?: BaileysMediaMessageLike | null;
  readonly documentMessage?: BaileysMediaMessageLike | null;
  readonly stickerMessage?: BaileysMediaMessageLike | null;
  readonly ephemeralMessage?: { readonly message?: BaileysMessageContentLike | null } | null;
  readonly viewOnceMessage?: { readonly message?: BaileysMessageContentLike | null } | null;
  readonly viewOnceMessageV2?: { readonly message?: BaileysMessageContentLike | null } | null;
  readonly viewOnceMessageV2Extension?: {
    readonly message?: BaileysMessageContentLike | null;
  } | null;
  readonly protocolMessage?: unknown;
}

export type BaileysTimestampLike =
  | number
  | string
  | bigint
  | { readonly toNumber: () => number }
  | null
  | undefined;

export type BaileysWaWebVersion = readonly [number, number, number];

export interface BaileysMessageLike {
  readonly key: {
    readonly id?: string | null;
    readonly remoteJid?: string | null;
    readonly participant?: string | null;
    readonly fromMe?: boolean | null;
  };
  readonly messageTimestamp?: BaileysTimestampLike;
  readonly message?: BaileysMessageContentLike | null;
}

export interface BaileysMessagesUpsertLike {
  readonly type: string;
  readonly messages: readonly BaileysMessageLike[];
  readonly requestId?: string;
}

export interface BaileysConnectionUpdateLike {
  readonly connection?: string | null;
  readonly qr?: string | null;
  readonly lastDisconnect?: {
    readonly error?: unknown;
    readonly date?: Date;
  } | null;
}

export interface BaileysLoggerLike {
  readonly level: string;
  child(bindings: unknown): BaileysLoggerLike;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface BaileysSocketConfigLike {
  readonly auth: unknown;
  readonly logger: BaileysLoggerLike;
  readonly markOnlineOnConnect: boolean;
  readonly shouldSyncHistoryMessage: (...args: unknown[]) => boolean;
  readonly syncFullHistory: boolean;
  readonly version?: BaileysWaWebVersion;
}

export interface BaileysEventMapLike {
  readonly "creds.update": Readonly<Record<string, unknown>>;
  readonly "messages.upsert": BaileysMessagesUpsertLike;
  readonly "connection.update": BaileysConnectionUpdateLike;
}

export interface BaileysEventSourceLike {
  on<EventName extends keyof BaileysEventMapLike>(
    event: EventName,
    listener: (value: BaileysEventMapLike[EventName]) => void,
  ): void;
}

export interface BaileysSocketLike {
  readonly ev: BaileysEventSourceLike;
  sendMessage(jid: string, content: { readonly text: string }): Promise<unknown>;
  end(error?: Error): void;
}

export interface BaileysRuntimeBridge {
  readonly loggedOutStatusCode: number;
  normalizeMessageContent(
    message: BaileysMessageContentLike | null | undefined,
  ): BaileysMessageContentLike | undefined;
  makeSocket(config: BaileysSocketConfigLike): BaileysSocketLike;
}
