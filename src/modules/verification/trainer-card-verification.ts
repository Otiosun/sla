import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  sign as signPayload,
  verify as verifyPayload,
} from "node:crypto";

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

export interface TrainerCardSnapshotSigner {
  sign(snapshot: TrainerCardPublicSnapshot): string;
}

export interface TrainerCardSnapshotVerifier {
  verify(snapshot: TrainerCardPublicSnapshot, signature: string): boolean;
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

function requireEd25519Key(key: KeyObject, purpose: "private" | "public"): KeyObject {
  if (key.type !== purpose || key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Trainer card ${purpose} key must be Ed25519`);
  }
  return key;
}

export class Ed25519TrainerCardSigner implements TrainerCardSnapshotSigner {
  private readonly privateKey: KeyObject;

  public constructor(privateKeyDer: Uint8Array) {
    this.privateKey = requireEd25519Key(
      createPrivateKey({
        key: Buffer.from(privateKeyDer),
        format: "der",
        type: "pkcs8",
      }),
      "private",
    );
  }

  public sign(snapshot: TrainerCardPublicSnapshot): string {
    const signature = signPayload(null, Buffer.from(canonicalSnapshot(snapshot)), this.privateKey);
    return `ed25519:${signature.toString("base64url")}`;
  }
}

export class Ed25519TrainerCardVerifier implements TrainerCardSnapshotVerifier {
  private readonly publicKey: KeyObject;

  public constructor(publicKeyDer: Uint8Array) {
    this.publicKey = requireEd25519Key(
      createPublicKey({
        key: Buffer.from(publicKeyDer),
        format: "der",
        type: "spki",
      }),
      "public",
    );
  }

  public verify(snapshot: TrainerCardPublicSnapshot, signature: string): boolean {
    const match = /^ed25519:([A-Za-z0-9_-]{86})$/.exec(signature);
    if (match === null) return false;

    const encoded = match[1];
    if (encoded === undefined) return false;
    const observed = Buffer.from(encoded, "base64url");
    if (observed.byteLength !== 64 || observed.toString("base64url") !== encoded) return false;

    return verifyPayload(null, Buffer.from(canonicalSnapshot(snapshot)), this.publicKey, observed);
  }
}

export class TrainerCardVerificationService {
  public constructor(
    private readonly repository: TrainerCardVerificationRepository,
    private readonly verifier: TrainerCardSnapshotVerifier,
  ) {}

  public async verify(publicId: string): Promise<TrainerCardVerificationResult> {
    const record = await this.repository.findByPublicId(publicId);
    if (record === null) return { status: "INVALID" };

    if (record.status === "REVOKED") {
      return { status: "REVOKED", publicId: record.publicId };
    }

    if (!this.verifier.verify(record.snapshot, record.signature)) {
      return { status: "INVALID" };
    }

    return {
      status: "VALID",
      publicId: record.publicId,
      snapshot: record.snapshot,
    };
  }
}
