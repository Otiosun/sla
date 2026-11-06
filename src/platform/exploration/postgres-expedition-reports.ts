import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AdminOperationRecord } from "../../modules/admin/contracts.js";
import { ADMIN_ERROR_CODES, AdminError } from "../../modules/admin/errors.js";
import { RulesetConfigSchema } from "../../modules/catalog/contracts.js";
import { EconomyService } from "../../modules/economy/service.js";
import {
  ExpeditionReportRewardPolicy,
  reportRewards,
} from "../../modules/exploration/expedition-report-policy.js";
import { expeditionOperationAllowed } from "../../modules/exploration/expedition-runtime-audience.js";
import {
  incomingMessageFingerprint,
  type MessageHandlerContext,
} from "../../modules/messaging/contracts.js";
import { AdjustTrainerProgressInputSchema } from "../../modules/progression/contracts.js";
import { parsePlayerId } from "../../shared-kernel/ids.js";
import { appError, err, ok } from "../../shared-kernel/result.js";
import { completeAppliedAdminOperationWithClient } from "../admin/postgres-admin-operation-completion.js";
import { PostgresAdminRepository } from "../admin/postgres-admin-repository.js";
import { withTransaction } from "../db/transaction.js";
import { economyRepositoryWithinTransaction } from "../economy/postgres-economy-repository.js";
import { PostgresProgressionRepository } from "../progression/postgres-progression-repository.js";

export interface ExpeditionReportRow {
  id: string;
  player_id: string;
  expedition_id: string;
  status: "SUBMITTED" | "APPROVED" | "REJECTED";
  revision: string;
  external_ref: string;
}
function fail(message: string): never {
  throw new AdminError(ADMIN_ERROR_CODES.DOMAIN_OPERATION_REJECTED, message);
}
function rewardLabel(value: unknown): string {
  if (typeof value !== "string") fail("O prêmio não possui nome válido.");
  const label = value
    .replace(/[\r\n*_~`<>]/gu, " ")
    .replace(/\u031d/gu, "")
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!label || label.length > 80) fail("O nome do prêmio não pode ser apresentado com segurança.");
  return label;
}
async function hasPendingFieldEffect(client: PoolClient, expeditionId: string): Promise<boolean> {
  const pending = await client.query(
    `SELECT 1 FROM (
       SELECT encounter_id FROM solo_expedition_search_outcomes WHERE expedition_id=$1
       UNION ALL
       SELECT encounter_id FROM solo_expedition_fishing_encounters WHERE expedition_id=$1
     ) outcome
     JOIN encounters encounter ON encounter.id=outcome.encounter_id
     LEFT JOIN battles battle ON battle.encounter_id=encounter.id
     LEFT JOIN battle_defeat_aftermath task ON task.battle_id=battle.id
     WHERE (
       encounter.status IN ('CREATED','PRESENTED','ENGAGED','CAPTURE_RESOLVING','IN_BATTLE')
       OR battle.status IN ('CREATED','ACTIVE','RESOLVING_TURN')
       OR (task.battle_id IS NOT NULL AND task.completed_at IS NULL)) LIMIT 1`,
    [expeditionId],
  );
  return pending.rowCount !== 0;
}

export class PostgresExpeditionReports {
  constructor(
    private readonly pool: Pool,
    private readonly rngKey: Uint8Array,
    private readonly operationalPlayers?: ReadonlySet<string>,
  ) {}
  async latest(playerId: string): Promise<ExpeditionReportRow | null> {
    return (
      (
        await this.pool.query<ExpeditionReportRow>(
          "SELECT id,player_id,expedition_id,status,revision::text,external_ref FROM solo_expedition_reports WHERE player_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [playerId],
        )
      ).rows[0] ?? null
    );
  }
  async operation(key: string) {
    const row = (
      await this.pool.query<{ id: string }>(
        "SELECT id FROM admin_operations WHERE idempotency_key=$1",
        [key],
      )
    ).rows[0];
    return row ? new PostgresAdminRepository(this.pool).getOperation(row.id) : null;
  }
  async submit(playerId: string, reference: string, context?: MessageHandlerContext) {
    if (this.operationalPlayers && !expeditionOperationAllowed(playerId))
      return err(appError("FLOW_BLOCKED", "Relatório indisponível para esta conta."));
    let parsed: URL;
    try {
      parsed = new URL(reference);
    } catch {
      return err(appError("VALIDATION_FAILED", "Informe o link HTTPS do relatório externo."));
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      reference.length > 2000
    )
      return err(appError("VALIDATION_FAILED", "Informe o link HTTPS do relatório externo."));
    try {
      const report = await withTransaction(this.pool, async (client) => {
        const owner = await client.query(
          "SELECT 1 FROM players p JOIN onboarding_states o ON o.player_id=p.id JOIN player_access a ON a.player_id=p.id AND a.status='ACTIVE' WHERE p.id=$1 AND p.status='ACTIVE' AND o.state='COMPLETE' FOR UPDATE OF p,a",
          [playerId],
        );
        if (owner.rowCount !== 1) fail("Seu cadastro não permite enviar relatório agora.");
        const inbox =
          context &&
          (
            await client.query<{
              result_ref_type: string | null;
              result_ref_id: string | null;
              attempts: number;
            }>(
              `SELECT inbox.result_ref_type,inbox.result_ref_id,inbox.attempts FROM inbox_messages inbox
           JOIN player_identities identity ON identity.provider=inbox.provider AND identity.external_id=$3
             AND identity.player_id=$2 AND identity.status='ACTIVE'
           WHERE inbox.id=$1 AND inbox.status='PROCESSING' AND inbox.provider=$4 AND inbox.payload_hash=$5
           FOR UPDATE OF inbox`,
              [
                context.inboxMessageId,
                playerId,
                context.message.senderRef,
                context.message.provider,
                incomingMessageFingerprint({
                  ...context.message,
                  text: context.originalMessageText ?? context.message.text,
                }),
              ],
            )
          ).rows[0];
        if (context && !inbox) fail("Não foi possível confirmar o envio do relatório.");
        if (inbox?.result_ref_type === "EXPEDITION_REPORT") {
          const committed = (
            await client.query<ExpeditionReportRow>(
              "SELECT id,player_id,expedition_id,status,revision::text,external_ref FROM solo_expedition_reports WHERE id=$1 AND player_id=$2",
              [inbox.result_ref_id, playerId],
            )
          ).rows[0];
          if (!committed || committed.external_ref !== reference)
            fail("A referência do relatório mudou.");
          return committed;
        }
        if (inbox && inbox.attempts > 1) fail("Envie o relatório novamente.");
        const ended = (
          await client.query<{ id: string }>(
            "SELECT id FROM solo_expeditions WHERE player_id=$1 AND phase='ENDED' AND end_reason IN ('VOLUNTARY','CLOCK') AND consumed_week_key IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",
            [playerId],
          )
        ).rows[0];
        if (!ended) fail("Não há uma expedição concluída elegível para relatório.");
        if (await hasPendingFieldEffect(client, ended.id))
          fail("Conclua o encontro e sua recuperação antes de enviar o relatório.");
        const prior = (
          await client.query<ExpeditionReportRow>(
            "SELECT id,player_id,expedition_id,status,revision::text,external_ref FROM solo_expedition_reports WHERE expedition_id=$1",
            [ended.id],
          )
        ).rows[0];
        if (prior && prior.external_ref !== reference)
          fail("Já existe um relatório vinculado a essa expedição. Consulte a equipe.");
        const result =
          prior ??
          (
            await client.query<ExpeditionReportRow>(
              "INSERT INTO solo_expedition_reports(id,expedition_id,player_id,external_ref) VALUES($1,$2,$3,$4) RETURNING id,player_id,expedition_id,status,revision::text,external_ref",
              [randomUUID(), ended.id, playerId, reference],
            )
          ).rows[0]!;
        if (context)
          await client.query(
            "UPDATE inbox_messages SET result_ref_type='EXPEDITION_REPORT',result_ref_id=$2 WHERE id=$1",
            [context.inboxMessageId, result.id],
          );
        return result;
      });
      return ok(report);
    } catch (error) {
      if (error instanceof AdminError) return err(appError("FLOW_BLOCKED", error.message));
      throw error;
    }
  }
  async apply(
    operation: AdminOperationRecord,
    actorPrincipalId: string,
    input: {
      reportId: string;
      playerId: string;
      mode: "NORMAL" | "HIGHLIGHT" | "REJECTED";
      wordCount: number;
    },
  ) {
    if (
      this.operationalPlayers &&
      (!expeditionOperationAllowed() || !this.operationalPlayers.has(input.playerId))
    )
      fail("Revisão indisponível para esta conta.");
    if (
      operation.operationType !== "exploration.report.review" ||
      operation.targetType !== "PLAYER" ||
      operation.targetId !== input.playerId ||
      operation.input.playerId !== input.playerId ||
      operation.input.reportId !== input.reportId ||
      operation.input.mode !== input.mode ||
      operation.input.wordCount !== input.wordCount
    )
      fail("A revisão não corresponde à operação administrativa autorizada.");
    await withTransaction(this.pool, async (client) => {
      const admin = (
        await client.query<{ status: string }>(
          "SELECT status FROM admin_operations WHERE id=$1 FOR UPDATE",
          [operation.id],
        )
      ).rows[0];
      if (admin?.status === "APPLIED") return;
      if (
        input.mode === "HIGHLIGHT" &&
        (!operation.reason?.trim() ||
          operation.reason === "Revisão explícita do relatório externo da expedição")
      )
        fail("O destaque exige justificativa narrativa com fatos verificados.");
      if (admin?.status !== "READY") fail("A revisão não está pronta para aplicação.");
      const owner = await client.query(
        "SELECT 1 FROM players p JOIN player_access a ON a.player_id=p.id AND a.status='ACTIVE' JOIN onboarding_states o ON o.player_id=p.id AND o.state='COMPLETE' WHERE p.id=$1 AND p.status='ACTIVE' FOR UPDATE OF p,a",
        [input.playerId],
      );
      if (owner.rowCount !== 1) fail("O treinador não está ativo para receber a revisão.");
      const report = (
        await client.query<ExpeditionReportRow>(
          "SELECT id,player_id,expedition_id,status,revision::text,external_ref FROM solo_expedition_reports WHERE id=$1 AND player_id=$2 FOR UPDATE",
          [input.reportId, input.playerId],
        )
      ).rows[0];
      if (
        !report ||
        report.status !== "SUBMITTED" ||
        BigInt(report.revision) !== operation.expectedRevision
      )
        throw new AdminError(
          ADMIN_ERROR_CODES.REVISION_CONFLICT,
          "Esse relatório já foi revisado ou mudou.",
        );
      const eligible = await client.query(
        "SELECT 1 FROM solo_expeditions WHERE id=$1 AND player_id=$2 AND phase='ENDED' AND end_reason IN ('VOLUNTARY','CLOCK') AND consumed_week_key IS NOT NULL FOR UPDATE",
        [report.expedition_id, input.playerId],
      );
      if (eligible.rowCount !== 1) fail("A expedição não admite premiação de conclusão.");
      if (await hasPendingFieldEffect(client, report.expedition_id))
        fail("A expedição ainda possui um encontro ou recuperação pendente.");
      let rewards: ReturnType<typeof reportRewards> | null = null,
        releaseId: string | null = null;
      const summary = new Map<string, { label: string; amount: bigint; kind: string }>();
      const summarize = (key: string, label: string, amount: bigint, kind: string) => {
        const previous = summary.get(key);
        summary.set(key, { label, amount: amount + (previous?.amount ?? 0n), kind });
      };
      if (input.mode !== "REJECTED") {
        if (input.wordCount < 100)
          fail("A equipe precisa confirmar pelo menos 100 palavras no relatório externo.");
        const policy = (
          await client.query<{ content_release_id: string; config: unknown }>(
            `SELECT p.content_release_id,p.config FROM solo_report_reward_policies p JOIN content_releases r ON r.id=p.content_release_id JOIN content_release_pointers a ON a.content_release_id=r.id AND a.pointer_key='ACTIVE' WHERE r.status='PUBLISHED' AND length(trim(p.approval_ref))>0 FOR SHARE OF p,r,a`,
          )
        ).rows[0];
        if (!policy)
          fail(
            "A premiação ainda não possui política aprovada e publicada. Nenhum prêmio foi concedido.",
          );
        releaseId = policy.content_release_id;
        try {
          rewards = reportRewards(
            policy.config,
            input.mode,
            this.rngKey,
            report.id + ":" + releaseId,
          );
        } catch {
          fail("A política publicada de premiação não é válida.");
        }
        const config = ExpeditionReportRewardPolicy.parse(policy.config);
        const possible = [
          ...config.base,
          ...[...config.normal, ...(input.mode === "HIGHLIGHT" ? config.highlight : [])]
            .filter((entry) => entry.weight > 0)
            .map((entry) => entry.reward),
        ];
        const items = [
          ...new Set(possible.flatMap((reward) => (reward.kind === "ITEM" ? [reward.itemId] : []))),
        ];
        const currencies = [
          ...new Set(
            possible.flatMap((reward) => (reward.kind === "MONEY" ? [reward.currencyId] : [])),
          ),
        ];
        const available = await client.query<{ items: number; currencies: number; rules: unknown }>(
          `SELECT
             (SELECT count(*)::int FROM item_revisions WHERE content_release_id=$1 AND active AND item_id=ANY($2::uuid[])) AS items,
             (SELECT count(*)::int FROM currency_definitions WHERE id=ANY($3::uuid[])) AS currencies,
             (SELECT ruleset.config FROM content_releases release JOIN rulesets ruleset ON ruleset.id=release.default_ruleset_id
              WHERE release.id=$1 AND ruleset.status='PUBLISHED') AS rules`,
          [releaseId, items, currencies],
        );
        const assets = available.rows[0];
        const rules = RulesetConfigSchema.safeParse(assets?.rules);
        if (
          assets?.items !== items.length ||
          assets.currencies !== currencies.length ||
          (possible.some((reward) => reward.kind === "TRAINER_POINTS") &&
            (!rules.success || rules.data.progression === undefined))
        )
          fail("A política de premiação ainda não pode ser executada integralmente.");
        const id = parsePlayerId(input.playerId);
        if (!id.ok) fail("Treinador inválido.");
        const economy = new EconomyService(economyRepositoryWithinTransaction(client));
        for (const [index, reward] of rewards.entries()) {
          const key = "expedition-report:" + report.id + ":" + index;
          const metadata = {
            sourceType: "EXPEDITION_REPORT",
            sourceId: report.id,
            reason: "Relatório externo aprovado",
            actorType: "ADMIN" as const,
            actorId: actorPrincipalId,
            correlationId: operation.correlationId,
          };
          if (reward.kind === "TRAINER_POINTS") {
            const result = await new PostgresProgressionRepository(this.pool)
              .adjustTrainerProgressInTransaction(
                client,
                AdjustTrainerProgressInputSchema.parse({
                  playerId: input.playerId,
                  delta: reward.amount,
                  idempotencyKey: key,
                  correlationId: operation.correlationId,
                  metadata: {
                    sourceType: metadata.sourceType,
                    sourceId: metadata.sourceId,
                    reason: metadata.reason,
                    actorType: metadata.actorType,
                    actorId: metadata.actorId,
                  },
                }),
              )
              .catch(() =>
                fail(
                  "Não foi possível aplicar a progressão canônica; nenhum prêmio foi concedido.",
                ),
              );
            if (result.kind !== "APPLIED" && result.kind !== "REPLAYED")
              fail("Não foi possível aplicar a progressão canônica.");
            summarize("points", "Pontos de treinador", BigInt(result.result.delta), "POINTS");
          } else if (reward.kind === "MONEY") {
            const currency = (
              await client.query<{ display_name: string }>(
                "SELECT display_name FROM currency_definitions WHERE id=$1",
                [reward.currencyId],
              )
            ).rows[0];
            if (!currency) fail("A moeda do prêmio não está disponível.");
            const result = await economy.creditWallet({
              playerId: id.value,
              currencyId: reward.currencyId,
              amount: BigInt(reward.amount),
              idempotencyKey: key,
              metadata,
            });
            if (!result.ok) fail("Não foi possível aplicar a carteira canônica.");
            summarize(
              "currency:" + reward.currencyId,
              rewardLabel(currency.display_name),
              BigInt(reward.amount),
              "MONEY",
            );
          } else {
            const catalog = await client.query<{ display_name: string }>(
              "SELECT display_name FROM item_revisions WHERE content_release_id=$1 AND item_id=$2 AND active",
              [releaseId, reward.itemId],
            );
            if (catalog.rowCount !== 1) fail("O prêmio não consta do catálogo publicado.");
            const result = await economy.addItem({
              playerId: id.value,
              itemId: reward.itemId,
              quantity: BigInt(reward.quantity),
              idempotencyKey: key,
              metadata,
            });
            if (!result.ok) fail("Não foi possível aplicar o inventário canônico.");
            summarize(
              "item:" + reward.itemId,
              rewardLabel(catalog.rows[0]?.display_name),
              BigInt(reward.quantity),
              "ITEM",
            );
          }
        }
      }
      const status = input.mode === "REJECTED" ? "REJECTED" : "APPROVED";
      await client.query(
        "UPDATE solo_expedition_reports SET status=$2,revision=revision+1,reviewed_word_count=$3,approval_mode=$4,admin_operation_id=$5,policy_release_id=$6,reward_result=$7::jsonb,reviewed_at=now() WHERE id=$1",
        [
          report.id,
          status,
          input.wordCount,
          input.mode,
          operation.id,
          releaseId,
          rewards === null ? null : JSON.stringify(rewards),
        ],
      );
      await completeAppliedAdminOperationWithClient(client, {
        operation,
        actorPrincipalId,
        resourceType: "EXPEDITION_REPORT",
        resourceId: report.id,
        beforeData: { status: report.status, revision: report.revision },
        afterData: { status, mode: input.mode, wordCount: input.wordCount, rewards },
        result: {
          status,
          reportId: report.id,
          rewardSummary: [...summary.values()].map((entry) =>
            entry.kind === "ITEM"
              ? `• ${entry.label} ×${entry.amount}`
              : `• ${entry.label}: +${entry.amount}`,
          ),
        },
        auditMetadata: { externalReportAttested: true, fieldRewardsRegranted: false },
      });
    });
    const applied = await new PostgresAdminRepository(this.pool).getOperation(operation.id);
    if (!applied) throw Error("Report operation missing");
    return applied;
  }
}
