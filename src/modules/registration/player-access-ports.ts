import type { PlayerId } from "../../shared-kernel/ids.js";

export type PlayerAccessStatus = "PENDING" | "PROVISIONING" | "ACTIVE" | "SUSPENDED";

export interface PlayerAccessRecord {
  readonly playerId: PlayerId;
  readonly status: PlayerAccessStatus;
  readonly approvedReviewId: string | null;
  readonly revision: number;
}

export interface BeginPlayerProvisioningWrite {
  readonly playerId: PlayerId;
  readonly reviewId: string;
  readonly expectedRevision: number;
}

export interface ActivatePlayerAccessWrite {
  readonly playerId: PlayerId;
  readonly reviewId: string;
  readonly expectedRevision: number;
}

export interface ChangePlayerAccessWrite {
  readonly playerId: PlayerId;
  readonly expectedRevision: number;
}

export interface PlayerAccessTransaction {
  load(playerId: PlayerId): Promise<PlayerAccessRecord>;
  beginProvisioning(input: BeginPlayerProvisioningWrite): Promise<PlayerAccessRecord | null>;
  activate(input: ActivatePlayerAccessWrite): Promise<PlayerAccessRecord | null>;
  suspend(input: ChangePlayerAccessWrite): Promise<PlayerAccessRecord | null>;
  restore(input: ChangePlayerAccessWrite): Promise<PlayerAccessRecord | null>;
}

export interface PlayerAccessRepository {
  transaction<T>(fn: (tx: PlayerAccessTransaction) => Promise<T>): Promise<T>;
  read<T>(fn: (tx: PlayerAccessTransaction) => Promise<T>): Promise<T>;
}
