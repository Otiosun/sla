import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { WorldService } from "../world/service.js";
import type { WorldServiceKind } from "./contracts.js";
import {
  renderFishingBite,
  renderFishingCast,
  renderFishingEncounter,
  renderFishingNoEncounter,
} from "./fishing-renderer.js";
import type { FishingService } from "./fishing-service.js";
import type { PokemonCenterHealingService } from "./healing-service.js";
import type { MartSaleInventoryReader } from "./mart-sale.js";
import { createPokemonPcOrganizeRoute } from "./pc-organize-whatsapp.js";
import {
  renderPokemonPcDepositSelection,
  renderPokemonPcWithdrawSelection,
} from "./pc-renderer.js";
import type { PokemonPcStorageService } from "./pc-storage-service.js";
import {
  renderCenterConversationMenu,
  renderMartCatalog,
  renderMartSaleList,
  renderPokemonCenterRecovery,
  renderPokemonPcBoxes,
  renderPokemonPcStorage,
  renderWorldServiceEntry,
  renderWorldServiceExit,
} from "./renderer.js";
import type { WorldServiceSessionService } from "./session-service.js";

const WORLD_SERVICE_POLICY = {
  requiredGroupCapabilities: ["world"],
  allowedPlayerAccess: ["ACTIVE"],
  requiresMechanicalReady: true,
} as const;

interface FishingSpeciesDisplayNameReader {
  speciesDisplayName(contentReleaseId: string, speciesId: string): Promise<string | null>;
}

export interface WorldServiceWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly world: Pick<WorldService, "getLocation">;
  readonly sessions: Pick<
    WorldServiceSessionService,
    "openVisit" | "loadActiveSession" | "closeVisit"
  >;
  readonly healing?: Pick<PokemonCenterHealingService, "healTeam">;
  readonly economy?: Pick<MartSaleInventoryReader, "listSellableInventory">;
  readonly pcStorage?: Pick<PokemonPcStorageService, "getStorage">;
  readonly fishing?: Pick<FishingService, "attempt">;
  readonly fishingSpecies?: FishingSpeciesDisplayNameReader;
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

interface WorldServicePromptAnchor {
  readonly playerId: PlayerId;
  readonly expectedRevision: bigint;
}

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly handler: Handler) {}

  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.handler(context);
  }
}

function identity(context: MessageHandlerContext): { provider: string; externalId: string } {
  return {
    provider: context.message.provider,
    externalId: context.message.senderRef,
  };
}

function isPokemonPcPrompt(key: string | null): boolean {
  return key !== null && key.includes(":center:pc");
}

async function resolvePlayer(
  dependencies: WorldServiceWhatsAppDependencies,
  context: MessageHandlerContext,
): Promise<Result<PlayerId>> {
  const resolved = await dependencies.players.resolvePlayer(identity(context));
  return resolved.ok ? ok(resolved.value.playerId) : resolved;
}

function textResult(
  context: MessageHandlerContext,
  text: string,
  resultRefId: string,
  prompt: WorldServicePromptAnchor | null = null,
  idempotencySuffix = "",
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "WORLD_SERVICE_SESSION",
    resultRefId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload:
          prompt === null
            ? { text }
            : {
                text,
                worldServicePrompt: {
                  playerId: prompt.playerId,
                  expectedRevision: prompt.expectedRevision.toString(),
                },
              },
        idempotencyKey: `${context.idempotencyKey}:world-service${idempotencySuffix}`,
      },
    ],
  });
}

function openHandler(
  dependencies: WorldServiceWhatsAppDependencies,
  serviceKind: WorldServiceKind,
): Handler {
  return async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const location = await dependencies.world.getLocation(player.value);
    if (!location.ok) return location;

    const opened = await dependencies.sessions.openVisit({
      playerId: player.value,
      areaId: location.value.areaId,
      serviceKind,
    });
    if (!opened.ok) return opened;

    return textResult(context, renderWorldServiceEntry(serviceKind), opened.value.sessionId, {
      playerId: player.value,
      expectedRevision: opened.value.revision,
    });
  };
}

export function createWorldServiceWhatsAppRoutes(
  dependencies: WorldServiceWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const close: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null) {
      return ok({
        resultRefType: null,
        resultRefId: null,
        outgoing: [],
      });
    }

    if (
      active.value.serviceKind === "POKEMON_CENTER" &&
      isPokemonPcPrompt(active.value.expectedReplyOutboxIdempotencyKey)
    ) {
      return textResult(
        context,
        renderWorldServiceEntry("POKEMON_CENTER"),
        active.value.sessionId,
        {
          playerId: player.value,
          expectedRevision: active.value.revision,
        },
        ":center:return",
      );
    }

    const closed = await dependencies.sessions.closeVisit({
      playerId: player.value,
      expectedRevision: active.value.revision,
    });
    if (!closed.ok) return closed;

    return textResult(context, renderWorldServiceExit(), closed.value.sessionId);
  };

  const buy: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMART") {
      return err(appError("ACTION_INVALID", "Poké Mart visit is not active"));
    }

    return textResult(
      context,
      renderMartCatalog(),
      active.value.sessionId,
      {
        playerId: player.value,
        expectedRevision: active.value.revision,
      },
      ":mart:catalog",
    );
  };

  const items: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMART") {
      return err(appError("ACTION_INVALID", "Poké Mart visit is not active"));
    }

    return textResult(
      context,
      renderMartCatalog(),
      active.value.sessionId,
      null,
      ":mart:items",
    );
  };

  const sell: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMART") {
      return err(appError("ACTION_INVALID", "Poké Mart visit is not active"));
    }
    if (dependencies.economy === undefined) {
      return err(appError("INVALID_STATE_TRANSITION", "Poké Mart sale service is unavailable"));
    }

    const sellable = await dependencies.economy.listSellableInventory(player.value);
    if (!sellable.ok) return sellable;
    const prompt =
      sellable.value.length === 0
        ? null
        : {
            playerId: player.value,
            expectedRevision: active.value.revision,
          };

    return textResult(
      context,
      renderMartSaleList(sellable.value),
      active.value.sessionId,
      prompt,
      sellable.value.length === 0 ? ":mart:sale:empty" : ":mart:sale:list",
    );
  };

  const heal: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }
    if (dependencies.healing === undefined) {
      return err(
        appError("INVALID_STATE_TRANSITION", "Pokémon Center healing service is unavailable"),
      );
    }

    const healed = await dependencies.healing.healTeam({
      playerId: player.value,
      sessionId: active.value.sessionId,
      sourceInboxMessageId: context.inboxMessageId,
      correlationId: context.correlationId,
    });
    if (!healed.ok) return healed;

    return textResult(
      context,
      renderPokemonCenterRecovery(),
      active.value.sessionId,
      null,
      ":center:heal",
    );
  };

  const pc: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }

    let rendered = renderWorldServiceEntry("PC");
    if (dependencies.pcStorage !== undefined) {
      const storage = await dependencies.pcStorage.getStorage(player.value);
      if (!storage.ok) return storage;
      rendered = renderPokemonPcStorage(storage.value);
    }

    return textResult(
      context,
      rendered,
      active.value.sessionId,
      {
        playerId: player.value,
        expectedRevision: active.value.revision,
      },
      ":center:pc",
    );
  };

  const boxes: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }
    if (dependencies.pcStorage === undefined) {
      return err(appError("INVALID_STATE_TRANSITION", "Pokémon PC storage service is unavailable"));
    }

    const storage = await dependencies.pcStorage.getStorage(player.value);
    if (!storage.ok) return storage;

    return textResult(
      context,
      renderPokemonPcBoxes(storage.value),
      active.value.sessionId,
      null,
      ":center:pc:boxes",
    );
  };

  const deposit: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }
    if (dependencies.pcStorage === undefined) {
      return err(appError("INVALID_STATE_TRANSITION", "Pokémon PC storage service is unavailable"));
    }

    const storage = await dependencies.pcStorage.getStorage(player.value);
    if (!storage.ok) return storage;

    return textResult(
      context,
      renderPokemonPcDepositSelection(storage.value),
      active.value.sessionId,
      {
        playerId: player.value,
        expectedRevision: active.value.revision,
      },
      ":center:pc:deposit:list",
    );
  };

  const withdraw: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }
    if (dependencies.pcStorage === undefined) {
      return err(appError("INVALID_STATE_TRANSITION", "Pokémon PC storage service is unavailable"));
    }

    const storage = await dependencies.pcStorage.getStorage(player.value);
    if (!storage.ok) return storage;
    const hasStoredPokemon = storage.value.boxes.some((box) => box.pokemon.length > 0);

    return textResult(
      context,
      renderPokemonPcWithdrawSelection(storage.value),
      active.value.sessionId,
      hasStoredPokemon
        ? {
            playerId: player.value,
            expectedRevision: active.value.revision,
          }
        : null,
      hasStoredPokemon ? ":center:pc:withdraw:list" : ":center:pc:withdraw:empty",
    );
  };

  const converse: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMON_CENTER") {
      return err(appError("ACTION_INVALID", "Pokémon Center visit is not active"));
    }

    return textResult(
      context,
      renderCenterConversationMenu(),
      active.value.sessionId,
      {
        playerId: player.value,
        expectedRevision: active.value.revision,
      },
      ":center:conversation",
    );
  };

  const fish: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    if (dependencies.fishing === undefined) {
      return err(appError("INVALID_STATE_TRANSITION", "Fishing service is unavailable"));
    }

    const attempted = await dependencies.fishing.attempt({
      playerId: player.value,
      idempotencyKey: context.idempotencyKey,
    });
    if (!attempted.ok) return attempted;

    const result = attempted.value;
    const outgoing = [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text: renderFishingCast(result) },
        idempotencyKey: `${context.idempotencyKey}:world-service:fishing:cast`,
      },
    ];

    if (result.encounter === null) {
      outgoing.push({
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text: renderFishingNoEncounter(result) },
        idempotencyKey: `${context.idempotencyKey}:world-service:fishing:result`,
      });
    } else {
      if (dependencies.fishingSpecies === undefined) {
        return err(
          appError("INVALID_STATE_TRANSITION", "Fishing species display reader is unavailable"),
        );
      }
      const speciesDisplayName = await dependencies.fishingSpecies.speciesDisplayName(
        result.encounter.contentReleaseId,
        result.encounter.snapshot.speciesId,
      );
      if (speciesDisplayName === null || speciesDisplayName.trim().length === 0) {
        return err(
          appError(
            "INVALID_STATE_TRANSITION",
            "Fishing encounter species display name is unavailable",
          ),
        );
      }

      outgoing.push(
        {
          channel: "whatsapp",
          destinationRef: context.message.chatRef,
          messageType: "TEXT",
          payload: { text: renderFishingBite() },
          idempotencyKey: `${context.idempotencyKey}:world-service:fishing:bite`,
        },
        {
          channel: "whatsapp",
          destinationRef: context.message.chatRef,
          messageType: "TEXT",
          payload: { text: renderFishingEncounter(result, speciesDisplayName) },
          idempotencyKey: `${context.idempotencyKey}:world-service:fishing:result`,
        },
      );
    }

    return ok({
      resultRefType: result.encounter === null ? "FISHING_ATTEMPT" : "ENCOUNTER",
      resultRefId: result.encounter?.encounterId ?? result.attemptId,
      outgoing,
    });
  };

  return [
    {
      command: "pokemart",
      handler: new FunctionalHandler(openHandler(dependencies, "POKEMART")),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "comprar",
      handler: new FunctionalHandler(buy),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "itens",
      handler: new FunctionalHandler(items),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "vender",
      handler: new FunctionalHandler(sell),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "centropokemon",
      handler: new FunctionalHandler(openHandler(dependencies, "POKEMON_CENTER")),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "curar",
      handler: new FunctionalHandler(heal),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "pc",
      handler: new FunctionalHandler(pc),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "caixas",
      handler: new FunctionalHandler(boxes),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "depositar",
      handler: new FunctionalHandler(deposit),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "retirar",
      handler: new FunctionalHandler(withdraw),
      policy: WORLD_SERVICE_POLICY,
    },
    createPokemonPcOrganizeRoute(dependencies),
    {
      command: "conversar",
      handler: new FunctionalHandler(converse),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "pescar",
      handler: new FunctionalHandler(fish),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "sair",
      handler: new FunctionalHandler(close),
      policy: WORLD_SERVICE_POLICY,
    },
  ];
}
