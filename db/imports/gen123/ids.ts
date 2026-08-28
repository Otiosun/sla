import { createHash } from "node:crypto";

export function gen123Id(key: string): string {
  const chars = createHash("sha256")
    .update(`rpg-pokemon/gen123/v1/${key}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "5";
  const variant = Number.parseInt(chars[16] ?? "0", 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function titleize(identifier: string): string {
  return identifier
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
