import type { Result } from "../../shared-kernel/result.js";
import type {
  MutationAdmissionDecision,
  MutationAdmissionPort,
  MutationRatePolicy,
  MutationSubjectKind,
  MutationSurface,
} from "./contracts.js";
import { mutationFingerprint } from "./fingerprint.js";

export interface ProtectedMutationAdmissionInput {
  readonly subjectKind: MutationSubjectKind;
  readonly subjectId: string;
  readonly surface: MutationSurface;
  readonly actionKey: string;
  readonly dedupeKey: string;
  readonly fingerprintValue: unknown;
  readonly policy: MutationRatePolicy;
}

export function admitProtectedMutation(
  admission: MutationAdmissionPort,
  input: ProtectedMutationAdmissionInput,
): Promise<Result<MutationAdmissionDecision>> {
  return admission.consume({
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    surface: input.surface,
    actionKey: input.actionKey,
    dedupeKey: input.dedupeKey,
    requestFingerprint: mutationFingerprint(input.fingerprintValue),
    policy: input.policy,
  });
}
