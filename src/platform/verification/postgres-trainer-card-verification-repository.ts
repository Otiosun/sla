import type { Pool } from "pg";
import type {
  TrainerCardIssuanceRecord,
  TrainerCardIssuanceRepository,
} from "../../modules/verification/trainer-card-issuance.js";
import type {
  TrainerCardPublicSnapshot,
  TrainerCardVerificationRecord,
  TrainerCardVerificationRepository,
} from "../../modules/verification/trainer-card-verification.js";

interface TrainerCardVerificationRow {
  readonly public_id: string;
  readonly status: string;
  readonly snapshot: unknown;
  readonly signature: string;
  readonly issued_at: Date;
  readonly revoked_at: Date | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicSnapshot(value: unknown): value is TrainerCardPublicSnapshot {
  if (!isObject(value) || value.version !== 1) return false;
  if (typeof value.trainerName !== "string" || value.trainerName.length === 0) return false;
  if (typeof value.trainerTitle !== "string") return false;
  if (typeof value.originRegion !== "string") return false;
  if (typeof value.currentLocation !== "string") return false;
  if (typeof value.issuedAt !== "string" || !Number.isFinite(Date.parse(value.issuedAt)))
    return false;

  if (!isObject(value.leadPokemon)) return false;
  if (!Number.isSafeInteger(value.leadPokemon.dex) || Number(value.leadPokemon.dex) <= 0)
    return false;
  if (typeof value.leadPokemon.nickname !== "string") return false;

  if (!Array.isArray(value.earnedBadgeKeys)) return false;
  if (value.earnedBadgeKeys.some((key) => typeof key !== "string")) return false;

  return true;
}

export class PostgresTrainerCardVerificationRepository
  implements TrainerCardVerificationRepository, TrainerCardIssuanceRepository
{
  public constructor(private readonly pool: Pool) {}

  public async issue(record: TrainerCardIssuanceRecord): Promise<boolean> {
    const issuedAt = new Date(record.snapshot.issuedAt);
    if (!Number.isFinite(issuedAt.getTime())) return false;
    if (!/^ed25519:[A-Za-z0-9_-]{86}$/.test(record.signature)) return false;

    const result = await this.pool.query(
      `INSERT INTO trainer_card_verifications (
         public_id,
         status,
         snapshot,
         signature,
         signature_algorithm,
         issued_at
       ) VALUES ($1, 'ACTIVE', $2::jsonb, $3, 'ED25519', $4)
       ON CONFLICT (public_id) DO NOTHING`,
      [record.publicId, JSON.stringify(record.snapshot), record.signature, issuedAt],
    );
    return result.rowCount === 1;
  }

  public async findByPublicId(publicId: string): Promise<TrainerCardVerificationRecord | null> {
    if (!/^tcv_[A-Za-z0-9]{24}$/.test(publicId)) return null;

    const result = await this.pool.query<TrainerCardVerificationRow>(
      `SELECT public_id, status, snapshot, signature, issued_at, revoked_at
       FROM trainer_card_verifications
       WHERE public_id = $1`,
      [publicId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    if (row.status !== "ACTIVE" && row.status !== "REVOKED") return null;
    if (!isPublicSnapshot(row.snapshot)) return null;
    if (!/^ed25519:[A-Za-z0-9_-]{86}$/.test(row.signature)) return null;
    if (new Date(row.snapshot.issuedAt).getTime() !== row.issued_at.getTime()) return null;

    return {
      publicId: row.public_id,
      status: row.status,
      snapshot: row.snapshot,
      signature: row.signature,
      revokedAt: row.revoked_at,
    };
  }

  public async revoke(publicId: string, revokedAt: Date): Promise<boolean> {
    if (!/^tcv_[A-Za-z0-9]{24}$/.test(publicId) || !Number.isFinite(revokedAt.getTime())) {
      return false;
    }

    const result = await this.pool.query(
      `UPDATE trainer_card_verifications
       SET status = 'REVOKED', revoked_at = $2
       WHERE public_id = $1 AND status = 'ACTIVE'`,
      [publicId, revokedAt],
    );
    return result.rowCount === 1;
  }
}
