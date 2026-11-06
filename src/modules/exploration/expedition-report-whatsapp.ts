import { createHash } from "node:crypto";
import { z } from "zod";
import type { PostgresExpeditionReports } from "../../platform/exploration/postgres-expedition-reports.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import { AdminError } from "../admin/errors.js";
import { type AdminOperationRegistry, defineAdminOperation } from "../admin/operation-registry.js";
import type { AdminService } from "../admin/service.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { PlayerRegistrationService } from "../player/registration-service.js";

const review = z
  .object({
    reportId: z.string().uuid(),
    playerId: z.string().uuid(),
    mode: z.enum(["NORMAL", "HIGHLIGHT", "REJECTED"]),
    wordCount: z.number().int().nonnegative().safe(),
  })
  .strict();
export function registerExpeditionReportReview(
  registry: AdminOperationRegistry,
  reports: PostgresExpeditionReports,
) {
  registry.register(
    defineAdminOperation({
      kind: "MUTATION",
      operationType: "exploration.report.review",
      capabilityKey: "reward.grant",
      riskTier: 2,
      authorizationMode: "SUBJECT",
      policy: {
        version: 1,
        requiresReason: true,
        requiresExpectedRevision: true,
        requiresSimulation: false,
        requiresConfirmation: false,
        requiredApprovals: 0,
      },
      inputSchema: review,
      target: (input) => ({ type: "PLAYER", id: input.playerId }),
      apply: (context, input) => reports.apply(context.operation, context.actorPrincipalId, input),
    }),
  );
}
export function createExpeditionReportHandler(deps: {
  players: Pick<PlayerRegistrationService, "resolvePlayer">;
  admins: {
    resolvePrincipal(input: {
      provider: string;
      externalId: string;
    }): Promise<{ principalId: string } | null>;
  };
  admin: Pick<AdminService, "prepareMutation" | "apply">;
  reports: PostgresExpeditionReports;
}): MessageRouteHandler {
  const reply = (
    context: MessageHandlerContext,
    text: string,
    reportId: string | null = null,
  ): Result<MessageHandlerResult> =>
    ok({
      resultRefType: reportId === null ? null : "EXPEDITION_REPORT",
      resultRefId: reportId,
      outgoing: [
        {
          channel: "whatsapp",
          destinationRef: context.message.senderRef,
          messageType: "TEXT",
          payload: { text },
          idempotencyKey: context.idempotencyKey + ":expedition-report",
        },
      ],
    });
  return {
    handle: async (context) => {
      const text = context.message.text?.trim() ?? "";
      const submission = /^\/explorar\s+relat[oó]rio\s+(https:\/\/\S+)$/iu.exec(text);
      if (submission) {
        const owner = await deps.players.resolvePlayer({
          provider: context.message.provider,
          externalId: context.message.senderRef,
        });
        if (!owner.ok) return owner;
        if (owner.value.state !== "COMPLETE")
          return err(appError("PLAYER_INELIGIBLE", "Conclua o cadastro para enviar o relatório."));
        const report = await deps.reports.submit(owner.value.playerId, submission[1]!, context);
        if (!report.ok) return report;
        if (report.value.status === "APPROVED")
          return reply(
            context,
            "◇ *𝗥𝗘𝗟𝗔𝗧Ó𝗥𝗜𝗢 𝗗𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*\n\nEste relatório já foi aprovado. A premiação já foi registrada e não foi concedida novamente.",
            report.value.id,
          );
        if (report.value.status === "REJECTED")
          return reply(
            context,
            "◇ *𝗥𝗘𝗟𝗔𝗧Ó𝗥𝗜𝗢 𝗗𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*\n\nEste relatório já foi rejeitado. Nenhum prêmio de conclusão foi concedido. Os resultados obtidos em campo permanecem preservados.",
            report.value.id,
          );
        return reply(
          context,
          "◇ *𝗥𝗘𝗟𝗔𝗧Ó𝗥𝗜𝗢 𝗗𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*\n\nReferência externa registrada.\nA equipe verificará o mínimo de 100 palavras e a aprovação. Nenhuma premiação foi concedida pelo envio.",
          report.value.id,
        );
      }
      const decision =
        /^\/explorar\s+revisar\s+(normal|destaque|rejeitar)\s+(\d+)(?:\s+@[^\s|]+)?(?:\s+\|\s+(.+))?$/iu.exec(
          text,
        );
      if (!decision || (context.message.mentions?.length ?? 0) !== 1)
        return err(
          appError(
            "VALIDATION_FAILED",
            "Envie /explorar relatorio <link HTTPS>. A equipe usa /explorar revisar normal|destaque|rejeitar <palavras conferidas> @treinador.",
          ),
        );
      const principal = await deps.admins.resolvePrincipal({
        provider: context.message.provider,
        externalId: context.message.senderRef,
      });
      if (!principal)
        return err(
          appError("PLAYER_INELIGIBLE", "Somente a equipe autorizada pode revisar relatórios."),
        );
      const owner = await deps.players.resolvePlayer({
        provider: context.message.provider,
        externalId: context.message.mentions![0]!,
      });
      if (!owner.ok) return owner;
      const mode =
        decision[1]!.toLocaleLowerCase("pt-BR") === "normal"
          ? "NORMAL"
          : decision[1]!.toLocaleLowerCase("pt-BR") === "destaque"
            ? "HIGHLIGHT"
            : "REJECTED";
      const reason = decision[3]?.trim();
      if (mode === "HIGHLIGHT" && (!reason || reason.length > 500))
        return err(
          appError(
            "VALIDATION_FAILED",
            "Acrescente | <justificativa narrativa com fatos verificados>.",
          ),
        );
      const wordCount = Number(decision[2]);
      if (!Number.isSafeInteger(wordCount) || (mode !== "REJECTED" && wordCount < 100))
        return err(
          appError(
            "VALIDATION_FAILED",
            "Confirme pelo menos 100 palavras no relatório externo antes de aprovar.",
          ),
        );
      try {
        const key =
          "expedition-review:" + createHash("sha256").update(context.idempotencyKey).digest("hex");
        const prior = await deps.reports.operation(key);
        if (
          prior &&
          (prior.principalId !== principal.principalId ||
            prior.input.playerId !== owner.value.playerId ||
            prior.input.mode !== mode ||
            prior.input.wordCount !== wordCount ||
            (reason !== undefined && prior.reason !== reason))
        )
          return err(appError("FINGERPRINT_MISMATCH", "A revisão retransmitida mudou."));
        const report = prior ? null : await deps.reports.latest(owner.value.playerId);
        if (!prior && !report)
          return err(appError("NOT_FOUND", "Esse treinador não tem relatório enviado."));
        const operation =
          prior ??
          (
            await deps.admin.prepareMutation({
              principalId: principal.principalId,
              operationType: "exploration.report.review",
              input: { reportId: report!.id, playerId: owner.value.playerId, mode, wordCount },
              expectedRevision: BigInt(report!.revision),
              reason: reason ?? "Revisão explícita do relatório externo da expedição",
              idempotencyKey: key,
              correlationId: context.correlationId,
            })
          ).operation;
        const applied = await deps.admin.apply(operation.id, principal.principalId);
        const result = reply(
          context,
          mode === "REJECTED"
            ? "◇ *𝗥𝗘𝗩𝗜𝗦Ã𝗢 𝗗𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*\n\nRelatório rejeitado. Nenhum prêmio de conclusão foi concedido. Os resultados legítimos obtidos em campo permanecem preservados."
            : "◇ *𝗥𝗘𝗩𝗜𝗦Ã𝗢 𝗗𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*\n\nRelatório aprovado. A premiação foi concedida uma única vez. Os resultados obtidos em campo permanecem preservados.",
        );
        if (!result.ok) return result;
        const raw = applied.result?.rewardSummary;
        const summary =
          Array.isArray(raw) && raw.every((value) => typeof value === "string")
            ? (raw as string[])
            : [];
        return ok({
          ...result.value,
          outgoing: [
            ...result.value.outgoing,
            {
              channel: "whatsapp",
              destinationRef: context.message.mentions![0]!,
              messageType: "TEXT",
              payload: {
                text:
                  mode === "REJECTED"
                    ? "◇ *𝗥𝗘𝗟𝗔𝗧Ó𝗥𝗜𝗢 𝗗𝗔 𝗘𝗫𝗣𝗘𝗗𝗜ÇÃ𝗢*\n\nSeu relatório foi rejeitado. Nenhum prêmio de conclusão foi concedido. Os resultados obtidos em campo permanecem preservados."
                    : [
                        "◇ *𝗥𝗘𝗟𝗔𝗧Ó𝗥𝗜𝗢 𝗔𝗣𝗥𝗢𝗩𝗔𝗗𝗢*",
                        "",
                        "◇ *𝗣𝗥𝗘𝗠𝗜𝗔ÇÃ𝗢*",
                        ...summary,
                        "",
                        "> _Premiação registrada uma única vez._",
                      ].join("\n"),
              },
              idempotencyKey: "expedition-report:" + operation.id + ":owner-notice",
            },
          ],
        });
      } catch (error) {
        if (error instanceof AdminError)
          return err(appError("FLOW_BLOCKED", error.message, { userMessage: error.message }));
        throw error;
      }
    },
  };
}
