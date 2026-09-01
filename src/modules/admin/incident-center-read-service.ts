import type {
  IncidentCenterReadRepository,
  IncidentCenterView,
  IncidentRunbookView,
  IncidentSignalEvidence,
  IncidentSignalView,
} from "./incident-center-read-contracts.js";

interface IncidentCenterReadAuthorizer {
  authorizeRead(request: {
    readonly principalId: string;
    readonly operationType: string;
    readonly input: Readonly<Record<string, never>>;
    readonly correlationId: string;
  }): Promise<unknown>;
}

export interface IncidentCenterReadRequest {
  readonly principalId: string;
  readonly correlationId: string;
}

const ADMIN_OPERATION_FAILED_RUNBOOK: IncidentRunbookView = Object.freeze({
  key: "admin-operation-failed",
  title: "Falha em operação administrativa",
  summary: "Preserve a correlação e confirme o contexto da operação antes de escalar a investigação.",
  steps: Object.freeze([
    "Confirme correlationId, tipo da operação, alvo e horário do sinal.",
    "Compare o sinal com a trilha de auditoria e com o estado atual do alvo, sem executar correções.",
    "Registre divergências de revisão, autorização ou domínio observadas na investigação.",
  ]),
  evidenceToCollect: Object.freeze([
    "correlationId",
    "kind",
    "target metadata",
    "riskTier",
    "occurredAt",
  ]),
  escalation:
    "Escalone para engenharia quando a causa não estiver explicada pela trilha de auditoria ou pelo estado atual do alvo.",
});

const INBOX_FAILED_RUNBOOK: IncidentRunbookView = Object.freeze({
  key: "inbox-processing-failed",
  title: "Falha no processamento de entrada",
  summary: "Investigue o processamento da mensagem recebida sem expor conteúdo bruto nem alterar a fila.",
  steps: Object.freeze([
    "Confirme correlationId, tentativas e horário do sinal.",
    "Compare o sinal com a saúde do runtime e com os metadados operacionais da Inbox.",
    "Determine se a falha é isolada ou recorrente usando somente evidência operacional permitida.",
  ]),
  evidenceToCollect: Object.freeze([
    "correlationId",
    "attempts",
    "occurredAt",
    "runtime health",
    "inbox metadata",
  ]),
  escalation:
    "Escalone para engenharia quando houver recorrência, degradação do runtime ou causa não explicada pelos metadados permitidos.",
});

const OUTBOX_FAILED_RUNBOOK: IncidentRunbookView = Object.freeze({
  key: "outbox-delivery-failed",
  title: "Falha temporária de saída",
  summary: "Verifique a evidência de entrega sem reenviar, reprocessar ou alterar a fila pela Central.",
  steps: Object.freeze([
    "Confirme correlationId, tentativas e horário do sinal.",
    "Compare o sinal com a saúde do runtime e com os metadados operacionais da Outbox.",
    "Observe se o mesmo padrão aparece em outros sinais recentes antes de escalar.",
  ]),
  evidenceToCollect: Object.freeze([
    "correlationId",
    "attempts",
    "occurredAt",
    "runtime health",
    "outbox metadata",
  ]),
  escalation:
    "Escalone para engenharia quando a falha persistir, se repetir em série ou coincidir com degradação do runtime.",
});

const OUTBOX_DEAD_RUNBOOK: IncidentRunbookView = Object.freeze({
  key: "outbox-dead-letter",
  title: "Mensagem em dead-letter",
  summary:
    "Trate o sinal como evidência persistente e preserve o estado para investigação antes de qualquer recuperação autorizada.",
  steps: Object.freeze([
    "Confirme correlationId, total de tentativas e horário de entrada em estado DEAD.",
    "Compare o sinal com os metadados de dead-letter e com a saúde do runtime.",
    "Documente a recorrência e encaminhe a recuperação para o fluxo privilegiado apropriado, fora desta superfície.",
  ]),
  evidenceToCollect: Object.freeze([
    "correlationId",
    "attempts",
    "occurredAt",
    "dead-letter metadata",
    "runtime health",
  ]),
  escalation:
    "Escalone para o responsável pelo fluxo de recuperação; a Central permanece somente observacional neste runbook.",
});

function contextualRunbook(evidence: IncidentSignalEvidence): IncidentRunbookView {
  if (evidence.source === "ADMIN_OPERATION" && evidence.state === "FAILED") {
    return ADMIN_OPERATION_FAILED_RUNBOOK;
  }
  if (evidence.source === "INBOX" && evidence.state === "FAILED") {
    return INBOX_FAILED_RUNBOOK;
  }
  if (evidence.source === "OUTBOX" && evidence.state === "FAILED") {
    return OUTBOX_FAILED_RUNBOOK;
  }
  if (evidence.source === "OUTBOX" && evidence.state === "DEAD") {
    return OUTBOX_DEAD_RUNBOOK;
  }

  throw new Error(`UNSUPPORTED_INCIDENT_RUNBOOK:${evidence.source}:${evidence.state}`);
}

function incidentView(evidence: IncidentSignalEvidence): IncidentSignalView {
  return {
    source: evidence.source,
    id: evidence.id,
    correlationId: evidence.correlationId,
    state: evidence.state,
    kind: evidence.kind,
    targetType: evidence.targetType,
    targetId: evidence.targetId,
    riskTier: evidence.riskTier,
    attempts: evidence.attempts,
    occurredAt: evidence.occurredAt.toISOString(),
    runbook: contextualRunbook(evidence),
  };
}

export class IncidentCenterReadService {
  public constructor(
    private readonly authorizer: IncidentCenterReadAuthorizer,
    private readonly repository: IncidentCenterReadRepository,
  ) {}

  public async getSnapshot(request: IncidentCenterReadRequest): Promise<IncidentCenterView> {
    await this.authorizer.authorizeRead({
      principalId: request.principalId,
      operationType: "incident.center.read",
      input: {},
      correlationId: request.correlationId,
    });

    const evidence = await this.repository.readRecent(25);
    return { signals: evidence.map(incidentView) };
  }
}
