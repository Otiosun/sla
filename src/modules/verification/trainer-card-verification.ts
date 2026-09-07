import { createHmac, timingSafeEqual } from "node:crypto";

export interface TrainerCardPublicSnapshot {
  readonly version: 1;
  readonly trainerName: string;
  readonly trainerTitle: string;
  readonly originRegion: string;
  readonly currentLocation: string;
  readonly leadPokemon: {
    readonly dex: number;
    readonly nickname: string;
  };
  readonly earnedBadgeKeys: readonly string[];
  readonly issuedAt: string;
}

export interface TrainerCardVerificationRecord {
  readonly publicId: string;
  readonly status: "ACTIVE" | "REVOKED";
  readonly snapshot: TrainerCardPublicSnapshot;
  readonly signature: string;
  readonly revokedAt: Date | null;
}

export interface TrainerCardVerificationRepository {
  findByPublicId(publicId: string): Promise<TrainerCardVerificationRecord | null>;
}

export type TrainerCardVerificationResult =
  | {
      readonly status: "VALID";
      readonly publicId: string;
      readonly snapshot: TrainerCardPublicSnapshot;
    }
  | {
      readonly status: "REVOKED";
      readonly publicId: string;
    }
  | {
      readonly status: "INVALID";
    };

function canonicalSnapshot(snapshot: TrainerCardPublicSnapshot): string {
  return JSON.stringify({
    version: snapshot.version,
    trainerName: snapshot.trainerName,
    trainerTitle: snapshot.trainerTitle,
    originRegion: snapshot.originRegion,
    currentLocation: snapshot.currentLocation,
    leadPokemon: {
      dex: snapshot.leadPokemon.dex,
      nickname: snapshot.leadPokemon.nickname,
    },
    earnedBadgeKeys: [...snapshot.earnedBadgeKeys],
    issuedAt: snapshot.issuedAt,
  });
}

export class HmacTrainerCardSigner {
  private readonly signingKey: Uint8Array;

  public constructor(signingKey: Uint8Array) {
    if (signingKey.byteLength < 32) {
      throw new Error("Trainer card signing key must be at least 32 bytes");
    }
    this.signingKey = new Uint8Array(signingKey);
  }

  public sign(snapshot: TrainerCardPublicSnapshot): string {
    return createHmac("sha256", this.signingKey).update(canonicalSnapshot(snapshot)).digest("hex");
  }

  public verify(snapshot: TrainerCardPublicSnapshot, signature: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(signature)) return false;

    const expected = Buffer.from(this.sign(snapshot), "hex");
    const observed = Buffer.from(signature, "hex");
    return observed.byteLength === expected.byteLength && timingSafeEqual(observed, expected);
  }
}

export class TrainerCardVerificationService {
  public constructor(
    private readonly repository: TrainerCardVerificationRepository,
    private readonly signer: HmacTrainerCardSigner,
  ) {}

  public async verify(publicId: string): Promise<TrainerCardVerificationResult> {
    const record = await this.repository.findByPublicId(publicId);
    if (record === null) return { status: "INVALID" };

    if (record.status === "REVOKED") {
      return { status: "REVOKED", publicId: record.publicId };
    }

    if (!this.signer.verify(record.snapshot, record.signature)) {
      return { status: "INVALID" };
    }

    return {
      status: "VALID",
      publicId: record.publicId,
      snapshot: record.snapshot,
    };
  }
}
