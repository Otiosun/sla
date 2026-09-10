import type { EncounterView } from "../encounter/contracts.js";
import type { EncounterService } from "../encounter/service.js";
import type { ExternalIdentity } from "../player/contracts.js";
import type { PlayerOnboardingRepository } from "../player/ports.js";
import type { PlayerPortalCatalogResolver } from "./read-service.js";
import { parseEncounterId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

export interface PlayerPortalEncounterWildView {
  readonly formId: string;
  readonly displayName: string | null;
  readonly nationalDex: number | null;
  readonly typeNames: readonly string[];
  readonly level: number;
  readonly currentHp: number;
  readonly maxHp: number;
  readonly shiny: boolean;
  readonly gender: string | null;
}

export interface PlayerPortalEncounterView {
  readonly encounterId: string;
  readonly areaId: string;
  readonly status: EncounterView["status"];
  readonly revision: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
  readonly closedAt: string | null;
  readonly wild: PlayerPortalEncounterWildView;
}

export interface PlayerPortalEncounterCreateInput {
  readonly idempotencyKey: string;
  readonly encounterTableSlug?: string;
}

export interface PlayerPortalEncounterMutationInput {
  readonly encounterId: string;
  readonly expectedRevision: string;
}

type EncounterActions = Pick<
  EncounterService,
  "createOrReplay" | "get" | "observe" | "engage" | "flee"
>;

export class PlayerPortalEncounterService {
  public constructor(
    private readonly repository: PlayerOnboardingRepository,
    private readonly encounter: EncounterActions,
    private readonly catalog: PlayerPortalCatalogResolver,
  ) {}

  public async create(
    identity: ExternalIdentity,
    input: PlayerPortalEncounterCreateInput,
  ): Promise<Result<PlayerPortalEncounterView>> {
    const playerId = await this.resolvePlayerId(identity);
    if (!playerId.ok) return playerId;

    const created = await this.encounter.createOrReplay({
      playerId: playerId.value,
      idempotencyKey: input.idempotencyKey,
      ...(input.encounterTableSlug === undefined
        ? {}
        : { encounterTableSlug: input.encounterTableSlug }),
    });
    if (!created.ok) return created;
    return this.mapView(created.value);
  }

  public async get(
    identity: ExternalIdentity,
    encounterId: string,
  ): Promise<Result<PlayerPortalEncounterView>> {
    const parsedEncounterId = parseEncounterId(encounterId);
    if (!parsedEncounterId.ok) return parsedEncounterId;
    const playerId = await this.resolvePlayerId(identity);
    if (!playerId.ok) return playerId;

    const view = await this.encounter.get(playerId.value, parsedEncounterId.value);
    if (!view.ok) return view;
    return this.mapView(view.value);
  }

  public async observe(
    identity: ExternalIdentity,
    input: PlayerPortalEncounterMutationInput,
  ): Promise<Result<PlayerPortalEncounterView>> {
    return this.mutate(identity, input, "observe");
  }

  public async engage(
    identity: ExternalIdentity,
    input: PlayerPortalEncounterMutationInput,
  ): Promise<Result<PlayerPortalEncounterView>> {
    return this.mutate(identity, input, "engage");
  }

  public async flee(
    identity: ExternalIdentity,
    input: PlayerPortalEncounterMutationInput,
  ): Promise<Result<PlayerPortalEncounterView>> {
    return this.mutate(identity, input, "flee");
  }

  private async mutate(
    identity: ExternalIdentity,
    input: PlayerPortalEncounterMutationInput,
    action: "observe" | "engage" | "flee",
  ): Promise<Result<PlayerPortalEncounterView>> {
    if (!/^\d+$/.test(input.expectedRevision)) {
      return err(appError("VALIDATION_FAILED", "Invalid encounter revision"));
    }
    const encounterId = parseEncounterId(input.encounterId);
    if (!encounterId.ok) return encounterId;
    const playerId = await this.resolvePlayerId(identity);
    if (!playerId.ok) return playerId;

    const mutated = await this.encounter[action]({
      playerId: playerId.value,
      encounterId: encounterId.value,
      expectedRevision: BigInt(input.expectedRevision),
    });
    if (!mutated.ok) return mutated;
    return this.mapView(mutated.value);
  }

  private async resolvePlayerId(identity: ExternalIdentity) {
    const playerId = await this.repository.read((transaction) =>
      transaction.findPlayerByIdentity(identity),
    );
    if (playerId === null) {
      return err(appError("NOT_FOUND", "Player portal encounter unavailable"));
    }
    return ok(playerId);
  }

  private async mapView(view: EncounterView): Promise<Result<PlayerPortalEncounterView>> {
    const catalog = await this.catalog.resolve({
      contentReleaseId: view.contentReleaseId,
      originRegionId: null,
      formIds: [view.snapshot.formId],
    });
    const presentation = catalog.forms.find((form) => form.formId === view.snapshot.formId);

    return ok({
      encounterId: view.encounterId,
      areaId: view.areaId,
      status: view.status,
      revision: view.revision.toString(),
      createdAt: view.createdAt.toISOString(),
      updatedAt: view.updatedAt.toISOString(),
      expiresAt: view.expiresAt?.toISOString() ?? null,
      closedAt: view.closedAt?.toISOString() ?? null,
      wild: {
        formId: view.snapshot.formId,
        displayName: presentation?.displayName ?? null,
        nationalDex: presentation?.nationalDex ?? null,
        typeNames: presentation?.typeNames ?? [],
        level: view.snapshot.level,
        currentHp: view.snapshot.currentHp,
        maxHp: view.snapshot.maxHp,
        shiny: view.snapshot.shiny,
        gender: view.snapshot.gender,
      },
    });
  }
}
