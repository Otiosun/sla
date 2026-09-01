import { describe, expect, it, vi } from "vitest";
import { IncidentCenterReadService } from "../../src/modules/admin/incident-center-read-service.js";

const PRINCIPAL_ID = "11111111-1111-4111-8111-111111111111";
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";

const common = {
  targetType: null,
  targetId: null,
  riskTier: null,
  occurredAt: new Date("2026-09-01T13:00:00.000Z"),
};

const evidence = [
  {
    ...common,
    source: "ADMIN_OPERATION" as const,
    id: "33333333-3333-4333-8333-333333333333",
    correlationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    state: "FAILED" as const,
    kind: "player.profile.edit",
    riskTier: 2,
    attempts: null,
  },
  {
    ...common,
    source: "INBOX" as const,
    id: "44444444-4444-4444-8444-444444444444",
    correlationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    state: "FAILED" as const,
    kind: "INBOX_MESSAGE",
    attempts: 3,
  },
  {
    ...common,
    source: "OUTBOX" as const,
    id: "55555555-5555-4555-8555-555555555555",
    correlationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    state: "FAILED" as const,
    kind: "OUTBOX_MESSAGE",
    attempts: 2,
  },
  {
    ...common,
    source: "OUTBOX" as const,
    id: "66666666-6666-4666-8666-666666666666",
    correlationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    state: "DEAD" as const,
    kind: "OUTBOX_MESSAGE",
    attempts: 8,
  },
];

describe("Incident Center contextual runbooks", () => {
  it("attaches an allowlisted observational runbook to every supported failure type", async () => {
    const service = new IncidentCenterReadService(
      { authorizeRead: vi.fn(async () => ({ type: "RUNTIME", id: null })) },
      { readRecent: vi.fn(async () => evidence) },
    );

    const result = await service.getSnapshot({
      principalId: PRINCIPAL_ID,
      correlationId: CORRELATION_ID,
    });

    expect(
      result.signals.map((signal) => ({
        source: signal.source,
        state: signal.state,
        runbook: signal.runbook,
      })),
    ).toEqual([
      {
        source: "ADMIN_OPERATION",
        state: "FAILED",
        runbook: {
          key: "admin-operation-failed",
          title: "Falha em operação administrativa",
          summary:
            "Preserve a correlação e confirme o contexto da operação antes de escalar a investigação.",
          steps: [
            "Confirme correlationId, tipo da operação, alvo e horário do sinal.",
            "Compare o sinal com a trilha de auditoria e com o estado atual do alvo, sem executar correções.",
            "Registre divergências de revisão, autorização ou domínio observadas na investigação.",
          ],
          evidenceToCollect: [
            "correlationId",
            "kind",
            "target metadata",
            "riskTier",
            "occurredAt",
          ],
          escalation:
            "Escalone para engenharia quando a causa não estiver explicada pela trilha de auditoria ou pelo estado atual do alvo.",
        },
      },
      {
        source: "INBOX",
        state: "FAILED",
        runbook: {
          key: "inbox-processing-failed",
          title: "Falha no processamento de entrada",
          summary:
            "Investigue o processamento da mensagem recebida sem expor conteúdo bruto nem alterar a fila.",
          steps: [
            "Confirme correlationId, tentativas e horário do sinal.",
            "Compare o sinal com a saúde do runtime e com os metadados operacionais da Inbox.",
            "Determine se a falha é isolada ou recorrente usando somente evidência operacional permitida.",
          ],
          evidenceToCollect: [
            "correlationId",
            "attempts",
            "occurredAt",
            "runtime health",
            "inbox metadata",
          ],
          escalation:
            "Escalone para engenharia quando houver recorrência, degradação do runtime ou causa não explicada pelos metadados permitidos.",
        },
      },
      {
        source: "OUTBOX",
        state: "FAILED",
        runbook: {
          key: "outbox-delivery-failed",
          title: "Falha temporária de saída",
          summary:
            "Verifique a evidência de entrega sem reenviar, reprocessar ou alterar a fila pela Central.",
          steps: [
            "Confirme correlationId, tentativas e horário do sinal.",
            "Compare o sinal com a saúde do runtime e com os metadados operacionais da Outbox.",
            "Observe se o mesmo padrão aparece em outros sinais recentes antes de escalar.",
          ],
          evidenceToCollect: [
            "correlationId",
            "attempts",
            "occurredAt",
            "runtime health",
            "outbox metadata",
          ],
          escalation:
            "Escalone para engenharia quando a falha persistir, se repetir em série ou coincidir com degradação do runtime.",
        },
      },
      {
        source: "OUTBOX",
        state: "DEAD",
        runbook: {
          key: "outbox-dead-letter",
          title: "Mensagem em dead-letter",
          summary:
            "Trate o sinal como evidência persistente e preserve o estado para investigação antes de qualquer recuperação autorizada.",
          steps: [
            "Confirme correlationId, total de tentativas e horário de entrada em estado DEAD.",
            "Compare o sinal com os metadados de dead-letter e com a saúde do runtime.",
            "Documente a recorrência e encaminhe a recuperação para o fluxo privilegiado apropriado, fora desta superfície.",
          ],
          evidenceToCollect: [
            "correlationId",
            "attempts",
            "occurredAt",
            "dead-letter metadata",
            "runtime health",
          ],
          escalation:
            "Escalone para o responsável pelo fluxo de recuperação; a Central permanece somente observacional neste runbook.",
        },
      },
    ]);

    const serialized = JSON.stringify(result);
    for (const forbiddenKey of [
      "command",
      "shell",
      "sql",
      "url",
      "action",
      "mutation",
      "retryEndpoint",
      "replayEndpoint",
      "requeueEndpoint",
    ]) {
      expect(serialized).not.toContain(`"${forbiddenKey}"`);
    }
  });
});
