import { z } from "zod";

const uuid = z.string().uuid();
const positiveStat = z.number().int().positive();
const iv = z.number().int().min(0).max(31);

export const WildPokemonSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    formId: uuid,
    speciesId: uuid,
    level: z.number().int().min(1).max(100),
    type1Id: uuid,
    type2Id: uuid.nullable(),
    baseStats: z
      .object({
        hp: positiveStat,
        attack: positiveStat,
        defense: positiveStat,
        spAttack: positiveStat,
        spDefense: positiveStat,
        speed: positiveStat,
      })
      .strict(),
    ivs: z
      .object({
        hp: iv,
        attack: iv,
        defense: iv,
        spAttack: iv,
        spDefense: iv,
        speed: iv,
      })
      .strict(),
    natureId: uuid,
    abilityId: uuid,
    moves: z
      .array(
        z
          .object({
            moveId: uuid,
            ppCurrent: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    maxHp: positiveStat,
    currentHp: z.number().int().nonnegative(),
    shiny: z.literal(false),
    gender: z.null(),
  })
  .strict()
  .refine((value) => value.currentHp <= value.maxHp, {
    path: ["currentHp"],
    message: "currentHp cannot exceed maxHp",
  });
