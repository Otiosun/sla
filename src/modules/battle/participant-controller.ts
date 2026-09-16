export type BattleParticipantControllerKind = "PLAYER" | "NARRATOR" | "AUTO";

export interface BattleParticipantController {
  readonly participantId: string;
  readonly battleId: string;
  readonly kind: BattleParticipantControllerKind;
  readonly playerId: string | null;
  readonly adminPrincipalId: string | null;
  readonly revision: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BattleParticipantControllerRepository {
  get(participantId: string): Promise<BattleParticipantController | null>;
  listByBattle(battleId: string): Promise<readonly BattleParticipantController[]>;
  initialize(
    controller: Omit<BattleParticipantController, "revision" | "createdAt" | "updatedAt">,
  ): Promise<BattleParticipantController>;
  transition(input: {
    readonly participantId: string;
    readonly expectedRevision: number;
    readonly kind: "NARRATOR" | "AUTO";
    readonly adminPrincipalId: string | null;
  }): Promise<BattleParticipantController | null>;
}
