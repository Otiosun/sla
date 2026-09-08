import { randomBytes } from "node:crypto";
import type { TrainerCardPublicSnapshot } from "./trainer-card-verification.js";
import { HmacTrainerCardSigner } from "./trainer-card-verification.js";

const PUBLIC_ID_PREFIX = "tcv_";
const PUBLIC_ID_LENGTH = 24;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const BASE62_ACCEPT_MAX = Math.floor(256 / BASE62.length) * BASE62.length;

export interface TrainerCardIssuanceRecord {
  readonly publicId: string;
  readonly status: "ACTIVE";
  readonly snapshot: TrainerCardPublicSnapshot;
  readonly signature: string;
}

export interface TrainerCardIssuanceRepository {
  issue(record: TrainerCardIssuanceRecord): Promise<boolean>;
}

export interface TrainerCardIssuanceResult {
  readonly publicId: string;
}

export function generateTrainerCardPublicId(): string {
  let opaque = "";
  while (opaque.length < PUBLIC_ID_LENGTH) {
    const bytes = randomBytes(PUBLIC_ID_LENGTH);
    for (const byte of bytes) {
      if (byte >= BASE62_ACCEPT_MAX) continue;
      opaque += BASE62[byte % BASE62.length];
      if (opaque.length === PUBLIC_ID_LENGTH) break;
    }
  }
  return `${PUBLIC_ID_PREFIX}${opaque}`;
}

export class TrainerCardIssuanceService {
  public constructor(
    private readonly repository: TrainerCardIssuanceRepository,
    private readonly signer: HmacTrainerCardSigner,
    private readonly generatePublicId: () => string = generateTrainerCardPublicId,
    private readonly maxCollisionRetries = 5,
  ) {
    if (!Number.isSafeInteger(maxCollisionRetries) || maxCollisionRetries <= 0) {
      throw new Error("Trainer card collision retry limit must be positive");
    }
  }

  public async issue(snapshot: TrainerCardPublicSnapshot): Promise<TrainerCardIssuanceResult> {
    const signature = this.signer.sign(snapshot);

    for (let attempt = 0; attempt < this.maxCollisionRetries; attempt += 1) {
      const publicId = this.generatePublicId();
      const inserted = await this.repository.issue({
        publicId,
        status: "ACTIVE",
        snapshot,
        signature,
      });
      if (inserted) return { publicId };
    }

    throw new Error("trainer card public id collision");
  }
}
