import { EvolutionTriggerSchemas, type EvolutionTriggerKind } from "../catalog/contracts.js";

export type EvolutionTrigger =
  | { readonly kind: "LEVEL"; readonly level: number }
  | { readonly kind: "ITEM"; readonly itemId: string }
  | { readonly kind: "CONDITION"; readonly conditionKey: string };

export interface EvolutionRuleView {
  readonly id: string;
  readonly fromFormId: string;
  readonly toFormId: string;
  readonly triggerKind: EvolutionTriggerKind;
  readonly triggerConfig: unknown;
}

export function evolutionRuleMatches(rule: EvolutionRuleView, trigger: EvolutionTrigger): boolean {
  if (rule.triggerKind !== trigger.kind) return false;
  const schema = EvolutionTriggerSchemas[rule.triggerKind];
  const parsed = schema.safeParse(rule.triggerConfig);
  if (!parsed.success) return false;

  if (rule.triggerKind === "LEVEL" && trigger.kind === "LEVEL") {
    return trigger.level >= parsed.data.level;
  }
  if (rule.triggerKind === "ITEM" && trigger.kind === "ITEM") {
    return trigger.itemId === parsed.data.itemId;
  }
  if (rule.triggerKind === "CONDITION" && trigger.kind === "CONDITION") {
    return trigger.conditionKey === parsed.data.conditionKey;
  }
  return false;
}
