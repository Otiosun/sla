import type { Pool } from "pg";
import {
  type CombatSceneBinding,
  type CombatSceneRecord,
  combatScenePrivateReply,
  type PreparedSceneAction,
} from "../../modules/battle/combat-scene-gate.js";
import { parseCombatSceneMessage } from "../../modules/battle/combat-scene-message.js";
import { BattleStateSchema } from "../../modules/battle/contracts.js";
import { validateBattleAction } from "../../modules/battle/legal.js";
import {
  actionFrom,
  type PveSceneDependencies,
  preflightPlayerMove,
  switchAction,
} from "../../modules/battle/pve-scene-whatsapp.js";
import { normalizeBattleRules } from "../../modules/battle/rules.js";
import { parseSceneAction } from "../../modules/battle/scene-action.js";
import { captureAttemptIdempotencyKey } from "../../modules/capture/service.js";
import type {
  MessageHandlerContext,
  MessageHandlerResult,
} from "../../modules/messaging/contracts.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { PostgresCatalogRepository } from "../catalog/postgres-catalog-repository.js";

type Dependencies = Pick<
  PveSceneDependencies,
  "players" | "admins" | "captureBalls" | "presentation" | "controllers" | "roster"
>;
export class PostgresCombatSceneContext {
  constructor(
    private readonly pool: Pool,
    private readonly deps: Dependencies,
  ) {}
  async bind(
    context: MessageHandlerContext,
    prepared?: PreparedSceneAction,
  ): Promise<Result<CombatSceneBinding>> {
    const actor = await this.deps.players.resolvePlayer({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const admin = await this.deps.admins.resolvePrincipal({
      provider: context.message.provider,
      externalId: context.message.senderRef,
    });
    const playerId = actor.ok && actor.value.state === "COMPLETE" ? actor.value.playerId : null;
    if (playerId === null && admin === null)
      return err(
        appError("PLAYER_INELIGIBLE", "Seu cadastro ou controle de batalha não está autorizado."),
      );
    const battles = await this.pool.query<{
      id: string;
      version: string;
      battle_type: string;
      encounter_id: string | null;
      actor_key: string;
      participant_id: string;
      state: unknown;
      deadline_at: Date | null;
      opened_at: Date | null;
    }>(
      `SELECT DISTINCT b.id,b.version::text,b.battle_type,b.encounter_id,
        CASE WHEN c.kind='PLAYER' THEN 'PLAYER:'||c.player_id::text ELSE 'NARRATOR:'||c.admin_principal_id::text END || ':' || c.revision::text AS actor_key,
        c.participant_id,s.state,w.deadline_at,w.opened_at
       FROM battles b JOIN battle_participant_controllers c ON c.battle_id=b.id
       JOIN battle_state_snapshots s ON s.battle_id=b.id AND s.version=b.version
       JOIN LATERAL jsonb_array_elements(s.state->'sides') side ON side->>'activeParticipantId'=c.participant_id::text
       LEFT JOIN battle_turn_windows w ON w.battle_id=b.id AND w.battle_version=b.version
       WHERE b.status='ACTIVE' AND ((c.kind='PLAYER' AND c.player_id=$1) OR (c.kind='NARRATOR' AND c.admin_principal_id=$2))`,
      [playerId, admin?.principalId ?? null],
    );
    if (battles.rows.length > 1)
      return err(
        appError(
          "FLOW_BLOCKED",
          "Há mais de um contexto de combate. Consulte /batalha antes de Cenar.",
        ),
      );
    const battle = battles.rows[0];
    let subjectId: string,
      version: number,
      subjectKind: "BATTLE" | "ENCOUNTER",
      release: string,
      actorKey: string,
      deadline: string | null,
      encounterId: string | null;
    let moves: readonly string[] = [];
    let forcedSwitch = false;
    if (battle) {
      const state = BattleStateSchema.parse(battle.state);
      subjectId = battle.id;
      version = Number(battle.version);
      subjectKind = "BATTLE";
      release = state.contentReleaseId;
      actorKey = battle.actor_key;
      deadline = battle.deadline_at?.toISOString() ?? null;
      encounterId = battle.encounter_id;
      const active = state.combatants.filter((c) => c.participantId === battle.participant_id);
      forcedSwitch = active.some((c) => c.currentHp === 0);
      const names = await this.deps.presentation.moveDisplayNames(
        release,
        active.flatMap((c) => c.moves.map((m) => m.moveId)),
      );
      moves = [...names.values()];
    } else {
      if (playerId === null)
        return err(appError("NOT_FOUND", "Nenhum encontro autorizado para esta Cena."));
      const encounters = await this.pool.query<{
        id: string;
        revision: string;
        content_release_id: string;
        expires_at: Date | null;
      }>(
        "SELECT id,revision::text,content_release_id,expires_at FROM encounters WHERE player_id=$1 AND status IN ('PRESENTED','ENGAGED')",
        [playerId],
      );
      const encounter = encounters.rows[0];
      if (encounters.rows.length !== 1 || !encounter)
        return err(appError("NOT_FOUND", "Nenhum combate ou encontro autorizado para esta Cena."));
      subjectId = encounter.id;
      version = Number(encounter.revision);
      subjectKind = "ENCOUNTER";
      release = encounter.content_release_id;
      actorKey = "PLAYER:" + playerId;
      deadline = encounter.expires_at?.toISOString() ?? null;
      encounterId = encounter.id;
      if (this.deps.roster) {
        const active = (await this.deps.roster.listTeam(playerId)).find(
          (pokemon) => pokemon.currentHp > 0,
        );
        const detail = active
          ? await this.deps.roster.teamPokemonDetail(playerId, active.slotNo)
          : null;
        moves = detail?.moves.map((move) => move.displayName) ?? [];
      }
    }
    // Only a completed canonical creation/start input establishes the chat.
    // Looking at an unrelated /batalha message can never rebind the origin.
    const origins = await this.pool.query<{ chat: string }>(
      `SELECT normalized_payload->>'chatRef' AS chat FROM inbox_messages
       WHERE provider=$1 AND status='PROCESSED'
        AND ((result_ref_type IN ('BATTLE','PVP') AND result_ref_id=$2)
          OR (result_ref_type='ENCOUNTER' AND result_ref_id=$3)
          OR (result_ref_type='PVP' AND result_ref_id IN(SELECT id FROM pvp_challenges WHERE battle_id=$2)))
        AND normalized_payload->>'text' ~ '(^|[[:space:]])/(spawn|desafiar|aceitar|iniciarbatalha)([[:space:]]|$)'
       ORDER BY received_at,id LIMIT 1`,
      [context.message.provider, subjectKind === "BATTLE" ? subjectId : null, encounterId],
    );
    let origin = origins.rows[0]?.chat;
    if (!origin && encounterId && playerId) {
      const exists = await this.pool.query<{ exists: boolean }>(
        "SELECT to_regclass('solo_expedition_search_outcomes') IS NOT NULL AS exists",
      );
      if (exists.rows[0]?.exists) {
        const search = await this.pool.query(
          "SELECT 1 FROM solo_expedition_search_outcomes WHERE encounter_id=$1 AND player_id=$2",
          [encounterId, playerId],
        );
        if (search.rowCount === 1) origin = context.message.senderRef;
      }
    }
    if (!origin)
      return err(
        appError(
          "FLOW_BLOCKED",
          "Não foi possível confirmar o chat de origem. Consulte a equipe antes de agir.",
        ),
      );
    if (origin.endsWith("@g.us")) {
      const capability = battle?.battle_type === "PVP" ? "pvp" : "pve";
      const allowed = await this.pool.query(
        "SELECT 1 FROM community_groups g JOIN community_group_capabilities c ON c.group_id=g.id WHERE g.provider=$1 AND g.chat_ref=$2 AND g.status='ACTIVE' AND c.capability_key=$3 AND c.active",
        [context.message.provider, origin, capability],
      );
      if (allowed.rowCount !== 1)
        return err(
          appError("FLOW_BLOCKED", "O grupo de origem não está autorizado para este combate."),
        );
    }
    if (context.message.replyToExternalMessageId !== null && prepared?.route !== "EXPEDITION") {
      const quote = await this.pool.query<{ valid: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM outbox_messages o JOIN inbox_messages i ON i.id=o.causation_id
          WHERE o.destination_ref=$1 AND upper(replace(o.id::text,'-',''))=upper($2)
           AND o.status='SENT' AND i.result_ref_id IN($3,$4)
           AND ($5::timestamptz IS NULL OR o.created_at >= $5)) AS valid`,
        [
          context.message.chatRef,
          context.message.replyToExternalMessageId,
          subjectId,
          encounterId,
          battle?.opened_at ?? null,
        ],
      );
      if (!quote.rows[0]?.valid)
        return err(
          appError(
            "REVISION_CONFLICT",
            "Essa referência não pertence ao turno atual. Consulte /batalha.",
          ),
        );
    }
    const balls =
      playerId && this.deps.captureBalls
        ? await this.deps.captureBalls.listAvailable(playerId, release)
        : [];
    const knownArguments = { movimento: moves, capturar: balls.map((b) => b.displayName) };
    if (prepared === undefined) {
      const parsed = parseCombatSceneMessage(
        context.originalMessageText ?? context.message.text ?? "",
        knownArguments,
      );
      if (!parsed.ok) return parsed;
      const intent = parseSceneAction(parsed.value.command);
      if (
        intent.kind === "ACTION" &&
        intent.intent.type !== "CAPTURE" &&
        intent.intent.type !== "SURRENDER"
      ) {
        if (battle) {
          const state = BattleStateSchema.parse(battle.state);
          const controllers = await this.deps.controllers.listByBattle(battle.id);
          const controller = controllers.find((c) => c.participantId === battle.participant_id);
          if (!controller)
            return err(appError("FLOW_BLOCKED", "Controle do ator não está disponível."));
          const action =
            intent.intent.type === "SWITCH"
              ? switchAction(state, controller, controllers, intent.intent.switchSlot)
              : await actionFrom(state, battle.participant_id, intent, this.deps.presentation);
          if (!action.ok) return action;
          const ruleset = await new PostgresCatalogRepository(this.pool).read((tx) =>
            tx.loadRuleset(state.rulesetId),
          );
          if (!ruleset)
            return err(appError("FLOW_BLOCKED", "As regras deste combate não estão disponíveis."));
          const rules = normalizeBattleRules(ruleset);
          if (!rules.ok) return err(appError("FLOW_BLOCKED", rules.error.message));
          const invalid = validateBattleAction(state, action.value, rules.value);
          if (invalid)
            return err(
              appError("VALIDATION_FAILED", "Essa ação não está disponível. Consulte /batalha."),
            );
        } else if (intent.intent.type === "USE_MOVE" && playerId) {
          const valid = await preflightPlayerMove(this.deps, playerId, intent.intent.moveRef);
          if (!valid.ok) return valid;
        } else if (intent.intent.type === "SWITCH") {
          return err(appError("FLOW_BLOCKED", "Inicie a batalha antes de trocar."));
        }
      }
    }
    if (!Number.isSafeInteger(version) || version < 0)
      return err(appError("FLOW_BLOCKED", "Versão de combate inválida."));
    return ok({
      subjectId,
      subjectKind,
      version,
      provider: context.message.provider,
      actorKey,
      originChat: origin,
      privateActionAllowed: battle?.battle_type === "PVP",
      deadline,
      knownArguments,
      forcedSwitch,
      captureAllowed: battle === undefined || battle.battle_type === "WILD",
    });
  }
  async recover(record: CombatSceneRecord): Promise<Result<MessageHandlerResult | null>> {
    const action = record.action;
    if (!action) return ok(null);
    const key = action.context.idempotencyKey;
    const binding = record.binding;
    const playerId = /^PLAYER:([0-9a-f-]{36})(?::\d+)?$/iu.exec(binding.actorKey)?.[1];
    const captureKey = playerId ? captureAttemptIdempotencyKey(playerId, key) : null;
    const attempts = await this.pool.query<{ status: string }>(
      "SELECT status FROM capture_attempts WHERE idempotency_key=$1 AND encounter_id=COALESCE($2::uuid,(SELECT encounter_id FROM battles WHERE id=$3))",
      [
        captureKey?.ok ? captureKey.value.storageKey : null,
        binding.subjectKind === "ENCOUNTER" ? binding.subjectId : null,
        binding.subjectKind === "BATTLE" ? binding.subjectId : null,
      ],
    );
    const submitted = await this.pool.query(
      "SELECT 1 FROM battle_turn_submissions s JOIN battle_turn_windows w ON w.id=s.turn_window_id WHERE s.idempotency_key=$1 AND w.battle_id=$2 AND w.battle_version=$3 AND s.status='COMMITTED'",
      [key, binding.subjectKind === "BATTLE" ? binding.subjectId : null, binding.version],
    );
    if (
      attempts.rows[0]?.status === "CAPTURED" ||
      (binding.subjectKind === "ENCOUNTER" && attempts.rows[0]?.status === "FAILED") ||
      submitted.rowCount
    ) {
      const recovered = combatScenePrivateReply(
        action.context,
        attempts.rowCount
          ? "◇ *𝗖𝗔𝗣𝗧𝗨𝗥𝗔*\n\nA tentativa já foi registrada. Consulte /equipe ou /box para conferir o resultado."
          : "A ação deste turno já foi registrada. Consulte /batalha.",
      );
      return ok({
        ...recovered,
        resultRefType: binding.subjectKind,
        resultRefId: binding.subjectId,
        outgoing: recovered.outgoing.map((message) => ({
          ...message,
          idempotencyKey: message.idempotencyKey + ":recovered",
        })),
      });
    }
    return ok(null);
  }
}
