export const OPERATIONAL_METRICS_CATALOG_VERSION = 1 as const;

type OperationalMetricUnit = "count" | "ratio" | "seconds";
type OperationalMetricWindow = "instant" | "5m" | "15m" | "1h";
type OperationalMetricDimension =
  | "operationType"
  | "riskTier"
  | "queue"
  | "status"
  | "incidentSource"
  | "incidentState"
  | "runtimeState";

export interface OperationalMetricDefinition {
  readonly key: string;
  readonly operationalQuestion: string;
  readonly operatorAction: string;
  readonly source: string;
  readonly unit: OperationalMetricUnit;
  readonly window: OperationalMetricWindow;
  readonly dimensions: readonly OperationalMetricDimension[];
}

export const OPERATIONAL_METRICS_CATALOG = [
  {
    key: "admin_operation_failure_count",
    operationalQuestion: "Quantas operações administrativas falharam recentemente?",
    operatorAction: "Investigar o padrão por tipo, risco e estado antes de escalar.",
    source: "admin_operations",
    unit: "count",
    window: "15m",
    dimensions: ["operationType", "riskTier", "status"],
  },
  {
    key: "admin_operation_failure_rate",
    operationalQuestion: "A proporção de falhas administrativas está aumentando?",
    operatorAction: "Comparar a proporção recente por tipo e risco e verificar a trilha operacional.",
    source: "admin_operations",
    unit: "ratio",
    window: "15m",
    dimensions: ["operationType", "riskTier", "status"],
  },
  {
    key: "messaging_inbox_backlog",
    operationalQuestion: "Há entradas acumuladas aguardando processamento?",
    operatorAction: "Verificar saúde do runtime e evolução dos contadores da fila de entrada.",
    source: "messaging_inbox",
    unit: "count",
    window: "instant",
    dimensions: ["queue", "status"],
  },
  {
    key: "messaging_inbox_failure_count",
    operationalQuestion: "Quantas entradas falharam no intervalo recente?",
    operatorAction: "Comparar falhas com backlog e saúde do runtime antes de escalar.",
    source: "messaging_inbox",
    unit: "count",
    window: "15m",
    dimensions: ["queue", "status"],
  },
  {
    key: "messaging_outbox_backlog",
    operationalQuestion: "Há saídas acumuladas aguardando envio?",
    operatorAction: "Verificar saúde do runtime e evolução dos contadores da fila de saída.",
    source: "messaging_outbox",
    unit: "count",
    window: "instant",
    dimensions: ["queue", "status"],
  },
  {
    key: "messaging_outbox_failure_count",
    operationalQuestion: "Quantas saídas falharam no intervalo recente?",
    operatorAction: "Comparar falhas com backlog e sinais de incidente antes de escalar.",
    source: "messaging_outbox",
    unit: "count",
    window: "15m",
    dimensions: ["queue", "status"],
  },
  {
    key: "messaging_outbox_dead_count",
    operationalQuestion: "Existem saídas persistentes em estado terminal de entrega?",
    operatorAction: "Preservar a evidência e encaminhar a recuperação ao fluxo privilegiado apropriado.",
    source: "messaging_outbox",
    unit: "count",
    window: "instant",
    dimensions: ["queue", "status"],
  },
  {
    key: "runtime_heartbeat_age_seconds",
    operationalQuestion: "Há quanto tempo o runtime não registra heartbeat?",
    operatorAction: "Comparar idade do heartbeat com o estado do runtime e escalar degradação persistente.",
    source: "runtime_instances",
    unit: "seconds",
    window: "instant",
    dimensions: ["runtimeState"],
  },
  {
    key: "incident_signal_count",
    operationalQuestion: "Quais classes de sinais de incidente estão se repetindo?",
    operatorAction: "Agrupar sinais por origem e estado para priorizar a investigação operacional.",
    source: "incident_center",
    unit: "count",
    window: "15m",
    dimensions: ["incidentSource", "incidentState"],
  },
] as const satisfies readonly OperationalMetricDefinition[];
