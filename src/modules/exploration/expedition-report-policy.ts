import { createHmac } from "node:crypto";
import { z } from "zod";

const quantity = z
  .string()
  .regex(/^[1-9]\d{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const ExpeditionReportReward = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MONEY"), currencyId: z.string().uuid(), amount: quantity }).strict(),
  z.object({ kind: z.literal("ITEM"), itemId: z.string().uuid(), quantity }).strict(),
  z
    .object({ kind: z.literal("TRAINER_POINTS"), amount: z.number().int().positive().safe() })
    .strict(),
]);
export type ExpeditionReportReward = z.infer<typeof ExpeditionReportReward>;
const weighted = z
  .array(
    z
      .object({ weight: z.number().int().nonnegative().max(10000), reward: ExpeditionReportReward })
      .strict(),
  )
  .min(1)
  .max(200)
  .refine((entries) => entries.reduce((sum, item) => sum + item.weight, 0) === 10000);
export const ExpeditionReportRewardPolicy = z
  .object({ base: z.array(ExpeditionReportReward).max(20), normal: weighted, highlight: weighted })
  .strict();

/** No defaults: the complete policy must come from explicitly approved content. */
export function reportRewards(
  config: unknown,
  mode: "NORMAL" | "HIGHLIGHT",
  key: Uint8Array,
  scope: string,
): ExpeditionReportReward[] {
  if (key.byteLength < 32) throw Error("Explicit report RNG key required");
  const policy = ExpeditionReportRewardPolicy.parse(config);
  const draw = (entries: z.infer<typeof weighted>, label: string) => {
    let value: number,
      counter = 0;
    const limit = Math.floor(4294967296 / 10000) * 10000;
    do {
      value = createHmac("sha256", key)
        .update("expedition.report\0" + scope + "\0" + label + "\0" + counter++)
        .digest()
        .readUInt32BE(0);
    } while (value >= limit);
    const roll = value % 10000;
    let cumulative = 0;
    for (const entry of entries) {
      cumulative += entry.weight;
      if (roll < cumulative) return entry.reward;
    }
    throw Error("Invalid report policy draw");
  };
  return [
    ...policy.base,
    draw(policy.normal, "normal"),
    ...(mode === "HIGHLIGHT" ? [draw(policy.highlight, "highlight")] : []),
  ];
}
