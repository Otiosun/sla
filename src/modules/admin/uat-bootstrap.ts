import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";
import type { PlayerStarterService } from "../player/starter-service.js";
import type { WorldService } from "../world/service.js";

type BootstrapResult = {
  readonly playerId: string;
  readonly access: string;
  readonly area: string;
  readonly party: string | null;
  readonly uat: boolean;
  readonly roster: boolean;
};

export class UatBootstrapService {
  public constructor(
    private readonly pool: Pool,
    private readonly players: PlayerRegistrationService,
    private readonly starter: PlayerStarterService,
    private readonly world: WorldService,
  ) {}

  public async bootstrap(
    identity: { provider: string; externalId: string },
    actorPrincipalId: string,
  ): Promise<Result<BootstrapResult>> {
    const resolved = await this.players.resolveOrCreatePlayer(identity);
    if (!resolved.ok) return resolved;
    const playerId = resolved.value.playerId;
    const setup = await this.pool.query<{ region_id: string; form_id: string }>(
      `SELECT starter.region_id, starter.form_id FROM content_release_pointers pointer JOIN starter_options starter ON starter.content_release_id = pointer.content_release_id AND starter.active = TRUE JOIN region_revisions region ON region.content_release_id = pointer.content_release_id AND region.region_id = starter.region_id AND region.active = TRUE JOIN regions identity ON identity.id = starter.region_id AND identity.slug = 'zhoulia' WHERE pointer.pointer_key = 'ACTIVE' ORDER BY starter.sort_order, starter.form_id LIMIT 1`,
    );
    const choice = setup.rows[0];
    if (choice === undefined)
      return err(appError("FEATURE_UNAVAILABLE", "No active UAT starter content is available"));
    let profile = await this.starter.getProfile(playerId);
    if (!profile.ok) return profile;
    if (profile.value.onboardingState === "NEW") {
      const created = await this.players.createProfile(playerId, { trainerName: "UAT Trainer" });
      if (!created.ok) return created;
      profile = await this.starter.getProfile(playerId);
      if (!profile.ok) return profile;
    }
    if (profile.value.onboardingState === "PROFILE_CREATED") {
      const selected = await this.players.selectRegion(playerId, { regionId: choice.region_id });
      if (!selected.ok) return selected;
      profile = await this.starter.getProfile(playerId);
      if (!profile.ok) return profile;
    }
    if (profile.value.onboardingState === "REGION_SELECTED") {
      const prepared = await this.starter.prepareStarterSelection(playerId);
      if (!prepared.ok) return prepared;
      const granted = await this.starter.grantStarter(playerId, { formId: choice.form_id });
      if (!granted.ok) return granted;
      profile = await this.starter.getProfile(playerId);
      if (!profile.ok) return profile;
    }
    if (profile.value.onboardingState === "STARTER_PENDING") {
      const granted = await this.starter.grantStarter(playerId, { formId: choice.form_id });
      if (!granted.ok) return granted;
      profile = await this.starter.getProfile(playerId);
      if (!profile.ok) return profile;
    }
    if (profile.value.onboardingState === "STARTER_GRANTED") {
      const complete = await this.starter.completeOnboarding(playerId);
      if (!complete.ok) return complete;
    }
    const location = await this.world.ensureInitialLocation({ playerId });
    if (!location.ok) return location;
    await this.pool.query(
      `INSERT INTO player_access(player_id,status,approved_review_id,access_origin,revision,created_at,updated_at) VALUES ($1,'ACTIVE',NULL,'UAT_BOOTSTRAP',1,now(),now()) ON CONFLICT (player_id) DO UPDATE SET access_origin = CASE WHEN player_access.status = 'PENDING' THEN 'UAT_BOOTSTRAP' ELSE player_access.access_origin END, status = CASE WHEN player_access.status = 'PENDING' OR player_access.access_origin = 'UAT_BOOTSTRAP' THEN 'ACTIVE' ELSE player_access.status END, updated_at = now()`,
      [playerId],
    );
    await this.pool.query(
      `INSERT INTO player_uat_bootstraps(player_id,bootstrapped_by) VALUES ($1,$2) ON CONFLICT (player_id) DO UPDATE SET last_prepared_at = now()`,
      [playerId, actorPrincipalId],
    );
    return ok({
      playerId,
      access: "ACTIVE",
      area: location.value.areaDisplayName,
      party: null,
      uat: true,
      roster: true,
    });
  }
  public async prepare(
    a: { provider: string; externalId: string },
    b: { provider: string; externalId: string },
    actor: string,
  ): Promise<Result<readonly BootstrapResult[]>> {
    const first = await this.bootstrap(a, actor);
    if (!first.ok) return first;
    const second = await this.bootstrap(b, actor);
    if (!second.ok) return second;
    await this.pool.query(
      `UPDATE player_locations SET area_id = (SELECT area_id FROM player_locations WHERE player_id=$1), entered_at=now(), revision=revision+1 WHERE player_id=$2`,
      [first.value.playerId, second.value.playerId],
    );
    const current = await this.pool.query<{ party_id: string }>(
      `SELECT party_id FROM player_party_members WHERE player_id = ANY($1::uuid[]) AND active = TRUE`,
      [[first.value.playerId, second.value.playerId]],
    );
    if (current.rows.length === 0) {
      const partyId = randomUUID();
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO player_parties(id,leader_player_id) VALUES ($1,$2)", [
          partyId,
          first.value.playerId,
        ]);
        await client.query(
          "INSERT INTO player_party_members(party_id,player_id) VALUES ($1,$2),($1,$3)",
          [partyId, first.value.playerId, second.value.playerId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } else if (current.rows.length !== 2 || current.rows[0]?.party_id !== current.rows[1]?.party_id)
      return err(
        appError("ACTION_INVALID", "Test actors already belong to incompatible active parties"),
      );
    return ok([first.value, second.value]);
  }
  public async status(identity: { provider: string; externalId: string }): Promise<Result<string>> {
    const player = await this.players.resolvePlayer(identity);

    if (!player.ok) {
      if (player.error.code !== "NOT_FOUND") return player;

      return ok(
        [
          "🧪 *DIAGNÓSTICO DE TESTE*",
          "",
          "WhatsApp: ✅ identificado",
          "Treinador: ❌ não criado",
          "Acesso: ❌ não configurado",
          "Localização: ❌ não definida",
          "Roster: ❌ ausente",
          "PVE: ❌ indisponível",
          "PVP: ❌ indisponível",
        ].join("\n"),
      );
    }

    const result = await this.pool.query<{
      uat: boolean;
      access: string;
      area: string | null;
      party: boolean;
      roster: boolean;
    }>(
      `SELECT
        EXISTS(
          SELECT 1
          FROM player_uat_bootstraps u
          WHERE u.player_id = p.id
        ) uat,
        COALESCE(a.status, 'PENDING') access,
        ar.display_name area,
        EXISTS(
          SELECT 1
          FROM player_party_members m
          JOIN player_parties pp ON pp.id = m.party_id
          WHERE m.player_id = p.id
            AND m.active
            AND pp.active
        ) party,
        EXISTS(
          SELECT 1
          FROM pokemon_roster_slots r
          JOIN pokemon_instances x ON x.id = r.pokemon_instance_id
          WHERE r.player_id = p.id
            AND r.placement_kind = 'TEAM'
            AND x.status = 'ACTIVE'
        ) roster
      FROM players p
      LEFT JOIN player_access a ON a.player_id = p.id
      LEFT JOIN player_locations l ON l.player_id = p.id
      LEFT JOIN content_release_pointers cp ON cp.pointer_key = 'ACTIVE'
      LEFT JOIN area_revisions ar
        ON ar.area_id = l.area_id
        AND ar.content_release_id = cp.content_release_id
      WHERE p.id = $1`,
      [player.value.playerId],
    );

    const row = result.rows[0];
    if (row === undefined) {
      return err(appError("NOT_FOUND", "Player was not found"));
    }

    const battleReady = row.roster && row.access === "ACTIVE";

    return ok(
      [
        "🧪 *DIAGNÓSTICO DE TESTE*",
        "",
        "WhatsApp: ✅ identificado",
        "Treinador: ✅ criado",
        `Teste/UAT: ${row.uat ? "✅ preparado" : "⚪ não preparado"}`,
        `Acesso: ${row.access === "ACTIVE" ? "✅ ACTIVE" : `⚠️ ${row.access}`}`,
        `Área: ${row.area === null ? "❌ não definida" : `✅ ${row.area}`}`,
        `Party: ${row.party ? "✅ ativa" : "⚪ nenhuma"}`,
        `Roster: ${row.roster ? "✅ pronto" : "❌ ausente"}`,
        `PVE: ${battleReady ? "✅ apto" : "❌ bloqueado"}`,
        `PVP: ${battleReady ? "✅ apto" : "❌ bloqueado"}`,
      ].join("\n"),
    );
  }
}

type UatIdentity = {
  readonly provider: string;
  readonly externalId: string;
};

export type UatBootstrapRouteService = Pick<
  UatBootstrapService,
  "bootstrap" | "prepare" | "status"
>;

const UAT_HELP = [
  "🧪 *CENTRAL DE TESTES*",
  "",
  "`/teste eu`",
  "Mostra seu estado atual.",
  "",
  "`/teste @jogador`",
  "Mostra o estado de outro jogador.",
  "",
  "`/teste preparar`",
  "Deixa você pronto para UAT.",
  "",
  "`/teste preparar @jogador`",
  "Deixa um jogador pronto.",
  "",
  "`/teste preparar @A @B`",
  "Prepara uma dupla, sincroniza a área e organiza a party de teste.",
].join("\n");

function normalizedCommandText(text: string | null): string {
  return (text ?? "").trim().normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
}

function identityFor(provider: string, externalId: string): UatIdentity {
  return { provider, externalId };
}

function uatReply(
  context: Parameters<CommandRouteDefinition["handler"]["handle"]>[0],
  text: string,
  suffix: string,
) {
  return ok({
    resultRefType: "UAT",
    // Replies do not identify a persisted domain entity (this column is UUID).
    resultRefId: null,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:${suffix}`,
      },
    ],
  });
}

function preparedText(result: BootstrapResult): string {
  return [
    "✅ *PRONTO PARA TESTE*",
    "",
    "Treinador: ✅",
    "Acesso: ✅ ACTIVE",
    `Área: ✅ ${result.area}`,
    "Roster: ✅ pronto",
    "PVE: ✅ apto",
    "PVP: ✅ apto",
    "",
    "Use `/teste eu` para conferir o estado completo.",
  ].join("\n");
}

export function createUatBootstrapRoutes(deps: {
  admins: {
    resolvePrincipal(input: {
      provider: string;
      externalId: string;
    }): Promise<{ principalId: string } | null>;
  };
  service: UatBootstrapRouteService;
}): readonly CommandRouteDefinition[] {
  const handler: CommandRouteDefinition["handler"] = {
    handle: async (context) => {
      const provider = context.message.provider;
      const sender = identityFor(provider, context.message.senderRef);
      const mentions = context.message.mentions ?? [];
      const text = normalizedCommandText(context.message.text);

      const principal = await deps.admins.resolvePrincipal(sender);

      if (principal === null) {
        return err(
          appError(
            "PLAYER_INELIGIBLE",
            "Este comando de teste exige uma conta administrativa autorizada.",
          ),
        );
      }

      const modern = /^[$/]teste(?:\s|$)/.test(text);
      const legacy = /^[$/]adm\s+teste(?:\s|$)/.test(text);

      if (!modern && !legacy) {
        return err(appError("VALIDATION_FAILED", UAT_HELP));
      }

      if (modern) {
        const rest = text.replace(/^[$/]teste\b/, "").trim();

        if (rest.length === 0) {
          return uatReply(context, UAT_HELP, "uat-help");
        }

        if (rest === "eu" || rest === "status" || rest === "status eu") {
          const status = await deps.service.status(sender);
          if (!status.ok) return status;

          return uatReply(
            context,
            `${status.value}\n\nUse \`/teste\` para continuar pela Central de Testes.`,
            "uat-status-self",
          );
        }

        if (rest.startsWith("preparar")) {
          if (mentions.length > 2) {
            return err(
              appError(
                "VALIDATION_FAILED",
                "Marque no máximo dois jogadores: `/teste preparar @A @B`.",
              ),
            );
          }

          if (mentions.length === 0) {
            const result = await deps.service.bootstrap(sender, principal.principalId);
            if (!result.ok) return result;

            return uatReply(context, preparedText(result.value), "uat-prepare-self");
          }

          if (mentions.length === 1) {
            const target = mentions[0];

            if (target === undefined) {
              return err(
                appError("VALIDATION_FAILED", "Não consegui identificar o jogador marcado."),
              );
            }

            const result = await deps.service.bootstrap(
              identityFor(provider, target),
              principal.principalId,
            );
            if (!result.ok) return result;

            return uatReply(context, preparedText(result.value), "uat-prepare-target");
          }

          const first = mentions[0];
          const second = mentions[1];

          if (first === undefined || second === undefined) {
            return err(
              appError("VALIDATION_FAILED", "Não consegui identificar os dois jogadores marcados."),
            );
          }

          if (first === second) {
            return err(
              appError(
                "VALIDATION_FAILED",
                "Marque dois jogadores diferentes para preparar uma dupla.",
              ),
            );
          }

          const result = await deps.service.prepare(
            identityFor(provider, first),
            identityFor(provider, second),
            principal.principalId,
          );

          if (!result.ok) return result;

          return uatReply(
            context,
            [
              "✅ *DUPLA PRONTA PARA TESTE*",
              "",
              "Jogador A: ✅ preparado",
              "Jogador B: ✅ preparado",
              `Área compartilhada: ✅ ${result.value[0]?.area ?? "definida"}`,
              "Party: ✅ organizada",
              "PVE: ✅ apto",
              "PVP: ✅ apto",
            ].join("\n"),
            "uat-prepare-pair",
          );
        }

        if (mentions.length === 1) {
          const target = mentions[0];

          if (target === undefined) {
            return err(
              appError("VALIDATION_FAILED", "Não consegui identificar o jogador marcado."),
            );
          }

          const status = await deps.service.status(identityFor(provider, target));
          if (!status.ok) return status;

          return uatReply(
            context,
            `${status.value}\n\nUse \`/teste\` para continuar pela Central de Testes.`,
            "uat-status-target",
          );
        }

        return err(
          appError(
            "VALIDATION_FAILED",
            "Não entendi esse comando. Use `/teste` para ver as opções.",
          ),
        );
      }

      if (/^[$/]adm\s+teste\s+status\b/.test(text)) {
        const target = mentions[0] ?? context.message.senderRef;
        const status = await deps.service.status(identityFor(provider, target));
        if (!status.ok) return status;

        return uatReply(context, status.value, "uat-legacy-status");
      }

      if (/^[$/]adm\s+teste\s+criar\b/.test(text)) {
        const target = mentions[0] ?? context.message.senderRef;
        const result = await deps.service.bootstrap(
          identityFor(provider, target),
          principal.principalId,
        );
        if (!result.ok) return result;

        return uatReply(context, preparedText(result.value), "uat-legacy-create");
      }

      if (/^[$/]adm\s+teste\s+preparar\b/.test(text)) {
        if (mentions.length === 0) {
          const result = await deps.service.bootstrap(sender, principal.principalId);
          if (!result.ok) return result;

          return uatReply(context, preparedText(result.value), "uat-legacy-prepare-self");
        }

        if (mentions.length === 1) {
          const target = mentions[0];

          if (target === undefined) {
            return err(
              appError("VALIDATION_FAILED", "Não consegui identificar o jogador marcado."),
            );
          }

          const result = await deps.service.bootstrap(
            identityFor(provider, target),
            principal.principalId,
          );
          if (!result.ok) return result;

          return uatReply(context, preparedText(result.value), "uat-legacy-prepare-target");
        }

        if (mentions.length === 2) {
          const first = mentions[0];
          const second = mentions[1];

          if (first === undefined || second === undefined || first === second) {
            return err(appError("VALIDATION_FAILED", "Marque dois jogadores diferentes."));
          }

          const result = await deps.service.prepare(
            identityFor(provider, first),
            identityFor(provider, second),
            principal.principalId,
          );
          if (!result.ok) return result;

          return uatReply(
            context,
            "✅ Dupla de teste preparada. Use `/teste @jogador` para conferir cada um.",
            "uat-legacy-prepare-pair",
          );
        }
      }
      return err(
        appError("VALIDATION_FAILED", "O comando antigo continua aceito, mas prefira `/teste`."),
      );
    },
  };

  const protectedRoute = (command: string): CommandRouteDefinition => ({
    command,
    rateLimitClass: "SENSITIVE",
    policy: { requiredAdminCapability: "UAT_BOOTSTRAP" },
    handler,
  });

  return [protectedRoute("teste"), protectedRoute("adm")];
}
