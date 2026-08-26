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

  switch (trigger.kind) {
    case "LEVEL": {
      if (rule.triggerKind !== "LEVEL") return false;
      const parsed = EvolutionTriggerSchemas.LEVEL.safeParse(rule.triggerConfig);
      return parsed.success && trigger.level >= parsed.data.level;
    }
    case "ITEM": {
      if (rule.triggerKind !== "ITEM") return false;
      const parsed = EvolutionTriggerSchemas.ITEM.safeParse(rule.triggerConfig);
      return parsed.success && trigger.itemId === parsed.data.itemId;
    }
    case "CONDITION": {
      if (rule.triggerKind !== "CONDITION") return false;
      const parsed = EvolutionTriggerSchemas.CONDITION.safeParse(rule.triggerConfig);
      return parsed.success && trigger.conditionKey === parsed.data.conditionKey;
    }
  }
}
