import type { Result } from "../../shared-kernel/result.js";

export const MutationSurfaceValues = ["CAPTURE", "BATTLE", "ECONOMY", "ADMIN"] as const;
export type MutationSurface = (typeof MutationSurfaceValues)[number];

export const MutationSubjectKindValues = ["PLAYER", "ADMIN_PRINCIPAL"] as const;
export type MutationSubjectKind = (typeof MutationSubjectKindValues)[number];

export interface MutationRatePolicy {
  readonly policyKey: string;
  readonly maxEvents: number;
  readonly windowMs: number;
}

export interface MutationAdmissionRequest {
  readonly subjectKind: MutationSubjectKind;
  readonly subjectId: string;
  readonly surface: MutationSurface;
  readonly actionKey: string;
  readonly dedupeKey: string;
  readonly requestFingerprint: string;
  readonly policy: MutationRatePolicy;
}

export interface MutationAdmissionDecision {
  readonly allowed: boolean;
  readonly replayed: boolean;
  readonly retryAfterMs: number;
}

export interface MutationAdmissionPort {
  consume(request: MutationAdmissionRequest): Promise<Result<MutationAdmissionDecision>>;
}

export interface MutationAdmissionPolicies {
  readonly capture: MutationRatePolicy;
  readonly battle: MutationRatePolicy;
  readonly economy: MutationRatePolicy;
  readonly admin: MutationRatePolicy;
}

export const DEFAULT_MUTATION_ADMISSION_POLICIES: MutationAdmissionPolicies = {
  capture: {
    policyKey: "capture.player.v1",
    maxEvents: 6,
    windowMs: 10_000,
  },
  battle: {
    policyKey: "battle.player-action.v1",
    maxEvents: 30,
    windowMs: 10_000,
  },
  economy: {
    policyKey: "economy.player-purchase.v1",
    maxEvents: 10,
    windowMs: 10_000,
  },
  admin: {
    policyKey: "admin.mutation.v1",
    maxEvents: 20,
    windowMs: 10_000,
  },
};
