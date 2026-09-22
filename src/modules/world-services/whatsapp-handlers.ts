import type { PlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { EncounterView } from "../encounter/contracts.js";
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
  renderPokemartFacade,
  renderPokemonCenterRecovery,
  renderPokemonPcBoxes,
  renderPokemonPcStorage,
  renderWorldServiceEntry,
  renderWorldServiceExit,
} from "./renderer.js";
import { qualifiesAsSceneProof } from "./scene-proof.js";
import type { WorldServiceSessionService } from "./session-service.js";

const WORLD_SERVICE_POLICY = {
  requiredGroupCapabilities: ["world"],
  allowedPlayerAccess: ["ACTIVE"],
  requiresMechanicalReady: true,
} as const;

interface FishingSpeciesDisplayNameReader {
  speciesDisplayName(contentReleaseId: string, speciesId: string): Promise<string | null>;
}

export interface PokemartEntryMedia {
  readonly facadeImageUrl: string;
  readonly merchantImageUrl: string;
}

export interface WorldServiceMediaCatalog {
  pokemartEntry(areaId: string): PokemartEntryMedia | null;
  zhouliaVilaArrivalImageUrl?(): string | null;
}

export interface WorldServiceWhatsAppDependencies {
  readonly players: Pick<PlayerRegistrationService, "resolvePlayer">;
  readonly world: Pick<WorldService, "getLocation"> & Partial<Pick<WorldService, "travelLock">>;
  readonly activeBattleId?: (playerId: PlayerId) => Promise<string | null>;
  readonly activeEncounter?: (playerId: PlayerId) => Promise<Result<EncounterView>>;
  readonly sessions: Pick<
    WorldServiceSessionService,
    "openVisit" | "loadActiveSession" | "closeVisit"
  > &
    Partial<Pick<WorldServiceSessionService, "recordSceneProof">>;
  readonly healing?: Pick<PokemonCenterHealingService, "healTeam">;
  readonly economy?: Pick<MartSaleInventoryReader, "listSellableInventory">;
  readonly pcStorage?: Pick<PokemonPcStorageService, "getStorage">;
  readonly fishing?: Pick<FishingService, "attempt">;
  readonly fishingSpecies?: FishingSpeciesDisplayNameReader;
  readonly media?: WorldServiceMediaCatalog;
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;
type OpenWorldServiceKind = Exclude<WorldServiceKind, "PC">;

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
  return key?.includes(":center:pc") === true;
}

async function resolvePlayer(
  dependencies: WorldServiceWhatsAppDependencies,
  context: MessageHandlerContext,
): Promise<Result<PlayerId>> {
  const resolved = await dependencies.players.resolvePlayer(identity(context));
  return resolved.ok ? ok(resolved.value.playerId) : resolved;
}

interface WorldServiceFlowGuardOptions {
  readonly requiresFreeWorld?: boolean;
}

async function ensureHigherPriorityFlowClear(
  dependencies: WorldServiceWhatsAppDependencies,
  playerId: PlayerId,
  options: WorldServiceFlowGuardOptions = {},
): Promise<Result<void>> {
  if (dependencies.activeBattleId !== undefined) {
    const battleId = await dependencies.activeBattleId(playerId);
    if (battleId !== null) {
      return err(
        appError("FLOW_BLOCKED", "Finalize a batalha ativa antes de usar Serviços.", { battleId }),
      );
    }
  }

  if (dependencies.activeEncounter !== undefined) {
    const activeEncounter = await dependencies.activeEncounter(playerId);
    if (activeEncounter.ok) {
      return err(
        appError("FLOW_BLOCKED", "Resolva o encontro ativo antes de usar Serviços.", {
          encounterId: activeEncounter.value.encounterId,
        }),
      );
    }
    if (activeEncounter.error.code !== "NOT_FOUND") return err(activeEncounter.error);
  }

  if (dependencies.world.travelLock !== undefined) {
    const travelLock = await dependencies.world.travelLock(playerId);
    if (!travelLock.ok) return err(travelLock.error);
    if (travelLock.value !== null) {
      return err(
        appError("FLOW_BLOCKED", "Aguarde o fim da viagem antes de usar Serviços.", {
          destinationAreaId: travelLock.value.destinationAreaId,
          availableAt: travelLock.value.availableAt.toISOString(),
        }),
      );
    }
  }

  if (options.requiresFreeWorld === true) {
    const activeSession = await dependencies.sessions.loadActiveSession(playerId);
    if (!activeSession.ok) return err(activeSession.error);
    if (activeSession.value !== null) {
      return err(
        appError("FLOW_BLOCKED", "Saia da instalação com `/sair` antes de pescar.", {
          activeServiceKind: activeSession.value.serviceKind,
        }),
      );
    }
  }

  return ok(undefined);
}

function guardWorldServiceHandler(
  dependencies: WorldServiceWhatsAppDependencies,
  handler: MessageRouteHandler,
  options: WorldServiceFlowGuardOptions = {},
): MessageRouteHandler {
  return new FunctionalHandler(async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;
    const flow = await ensureHigherPriorityFlowClear(dependencies, player.value, options);
    if (!flow.ok) return flow;
    return handler.handle(context);
  });
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

function pokemartMediaResult(
  context: MessageHandlerContext,
  resultRefId: string,
  prompt: WorldServicePromptAnchor,
  media: PokemartEntryMedia,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "WORLD_SERVICE_SESSION",
    resultRefId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "IMAGE",
        payload: {
          imageUrl: media.facadeImageUrl,
          caption: renderPokemartFacade(),
        },
        idempotencyKey: `${context.idempotencyKey}:world-service:entry:facade`,
      },
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "IMAGE",
        payload: {
          imageUrl: media.merchantImageUrl,
          caption: renderWorldServiceEntry("POKEMART"),
          worldServicePrompt: {
            playerId: prompt.playerId,
            expectedRevision: prompt.expectedRevision.toString(),
          },
        },
        idempotencyKey: `${context.idempotencyKey}:world-service:entry:merchant`,
      },
    ],
  });
}

function openHandler(
  dependencies: WorldServiceWhatsAppDependencies,
  serviceKind: OpenWorldServiceKind,
): Handler {
  return async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const location = await dependencies.world.getLocation(player.value);
    if (!location.ok) return location;
    if (!location.value.facilities?.includes(serviceKind)) {
      return err(
        appError("FLOW_BLOCKED", "World service is not available in the current area", {
          serviceKind,
          areaId: location.value.areaId,
          userMessage: "Esse serviço não está disponível na área em que você está agora.",
        }),
      );
    }

    const fullInboundText = context.originalMessageText ?? context.message.text;
    if (
      dependencies.sessions.recordSceneProof !== undefined &&
      fullInboundText !== null &&
      qualifiesAsSceneProof(fullInboundText)
    ) {
      const recorded = await dependencies.sessions.recordSceneProof({
        playerId: player.value,
        areaId: location.value.areaId,
        sourceInboxMessageId: context.inboxMessageId,
        text: fullInboundText,
      });
      if (!recorded.ok) return recorded;
    }

    const opened = await dependencies.sessions.openVisit({
      playerId: player.value,
      areaId: location.value.areaId,
      serviceKind,
    });
    if (!opened.ok) return opened;

    const prompt = {
      playerId: player.value,
      expectedRevision: opened.value.revision,
    };
    if (serviceKind === "POKEMART") {
      const media = dependencies.media?.pokemartEntry(location.value.areaId) ?? null;
      if (media !== null) {
        return pokemartMediaResult(context, opened.value.sessionId, prompt, media);
      }
    }

    return textResult(
      context,
      renderWorldServiceEntry(serviceKind),
      opened.value.sessionId,
      prompt,
    );
  };
}

export function createWorldServiceWhatsAppRoutes(
  dependencies: WorldServiceWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const guarded = (handler: Handler, options: WorldServiceFlowGuardOptions = {}) =>
    guardWorldServiceHandler(dependencies, new FunctionalHandler(handler), options);
  const organizeRoute = createPokemonPcOrganizeRoute(dependencies);
  const guardedOrganizeRoute: CommandRouteDefinition = {
    ...organizeRoute,
    allowEmbedded: true,
    handler: guardWorldServiceHandler(dependencies, organizeRoute.handler),
  };

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
      return err(
        appError("FLOW_BLOCKED", "Poké Mart visit is not active", {
          userMessage: "Entre no Poké Mart com `/pokemart` antes de usar esse comando.",
        }),
      );
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
      return err(
        appError("FLOW_BLOCKED", "Poké Mart visit is not active", {
          userMessage: "Entre no Poké Mart com `/pokemart` antes de usar esse comando.",
        }),
      );
    }

    return textResult(context, renderMartCatalog(), active.value.sessionId, null, ":mart:items");
  };

  const sell: Handler = async (context) => {
    const player = await resolvePlayer(dependencies, context);
    if (!player.ok) return player;

    const active = await dependencies.sessions.loadActiveSession(player.value);
    if (!active.ok) return active;
    if (active.value === null || active.value.serviceKind !== "POKEMART") {
      return err(
        appError("FLOW_BLOCKED", "Poké Mart visit is not active", {
          userMessage: "Entre no Poké Mart com `/pokemart` antes de usar esse comando.",
        }),
      );
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
      return err(
        appError("FLOW_BLOCKED", "Pokémon Center visit is not active", {
          userMessage: "Entre no Centro Pokémon com `/centropokemon` antes de usar esse comando.",
        }),
      );
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
      return err(
        appError("FLOW_BLOCKED", "Pokémon Center visit is not active", {
          userMessage: "Entre no Centro Pokémon com `/centropokemon` antes de usar esse comando.",
        }),
      );
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
      return err(
        appError("FLOW_BLOCKED", "Pokémon Center visit is not active", {
          userMessage: "Entre no Centro Pokémon com `/centropokemon` antes de usar esse comando.",
        }),
      );
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
      return err(
        appError("FLOW_BLOCKED", "Pokémon Center visit is not active", {
          userMessage: "Entre no Centro Pokémon com `/centropokemon` antes de usar esse comando.",
        }),
      );
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
      return err(
        appError("FLOW_BLOCKED", "Pokémon Center visit is not active", {
          userMessage: "Entre no Centro Pokémon com `/centropokemon` antes de usar esse comando.",
        }),
      );
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
      return err(
        appError("FLOW_BLOCKED", "Pokémon Center visit is not active", {
          userMessage: "Entre no Centro Pokémon com `/centropokemon` antes de usar esse comando.",
        }),
      );
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
      allowEmbedded: true,
      handler: guarded(openHandler(dependencies, "POKEMART")),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "comprar",
      allowEmbedded: true,
      handler: guarded(buy),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "itens",
      allowEmbedded: true,
      handler: guarded(items),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "vender",
      allowEmbedded: true,
      handler: guarded(sell),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "centropokemon",
      allowEmbedded: true,
      handler: guarded(openHandler(dependencies, "POKEMON_CENTER")),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "curar",
      allowEmbedded: true,
      handler: guarded(heal),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "pc",
      allowEmbedded: true,
      handler: guarded(pc),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "caixas",
      allowEmbedded: true,
      handler: guarded(boxes),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "depositar",
      allowEmbedded: true,
      handler: guarded(deposit),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "retirar",
      allowEmbedded: true,
      handler: guarded(withdraw),
      policy: WORLD_SERVICE_POLICY,
    },
    guardedOrganizeRoute,
    {
      command: "conversar",
      allowEmbedded: true,
      handler: guarded(converse),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "pescar",
      allowEmbedded: true,
      handler: guarded(fish, { requiresFreeWorld: true }),
      policy: WORLD_SERVICE_POLICY,
    },
    {
      command: "sair",
      allowEmbedded: true,
      handler: new FunctionalHandler(close),
      policy: WORLD_SERVICE_POLICY,
    },
  ];
}
