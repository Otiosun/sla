import { describe, expect, it, vi } from "vitest";
import { PostgresAutoBattleTerminalWhatsAppProjector } from "../../src/platform/battle/postgres-auto-battle-terminal-whatsapp-projector.js";

describe("AUTO battle terminal WhatsApp projector", () => {
  it("projects one compact mentioned defeat and remains idempotent at the DB boundary", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            battle_id: "11111111-1111-4111-8111-111111111111",
            status: "LOST",
            player_id: "22222222-2222-4222-8222-222222222222",
            chat_ref: "group@g.us",
            external_id: "5511999999999@s.whatsapp.net",
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await new PostgresAutoBattleTerminalWhatsAppProjector({
      query,
    } as never).runOnce(10);

    expect(result).toEqual({ claimed: 1, projected: 1 });
    expect(query).toHaveBeenCalledTimes(2);
    const insertArgs = query.mock.calls[1]?.[1] as readonly unknown[];
    const payload = JSON.parse(String(insertArgs[2]));
    expect(payload.text).toContain("BATALHA AUTOMÁTICA · FIM");
    expect(payload.text).toContain("@5511999999999");
    expect(payload.text).toContain("Derrota");
    expect(payload.mentions).toEqual(["5511999999999@s.whatsapp.net"]);
    expect(insertArgs[3]).toBe(
      "battle.auto-terminal-whatsapp:11111111-1111-4111-8111-111111111111",
    );
  });

  it("projects an automatic player victory instead of silently relying on reward output", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            battle_id: "11111111-1111-4111-8111-111111111111",
            status: "WON",
            player_id: "22222222-2222-4222-8222-222222222222",
            chat_ref: "group@g.us",
            external_id: "5511999999999@s.whatsapp.net",
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await new PostgresAutoBattleTerminalWhatsAppProjector({
      query,
    } as never).runOnce(10);

    expect(result).toEqual({ claimed: 1, projected: 1 });
    const insertArgs = query.mock.calls[1]?.[1] as readonly unknown[];
    const payload = JSON.parse(String(insertArgs[2]));
    expect(payload.text).toContain("BATALHA AUTOMÁTICA · FIM");
    expect(payload.text).toContain("Vitória");
    expect(payload.mentions).toEqual(["5511999999999@s.whatsapp.net"]);
  });

  it("rejects unsafe batch limits before querying", async () => {
    const query = vi.fn();
    const projector = new PostgresAutoBattleTerminalWhatsAppProjector({ query } as never);

    await expect(projector.runOnce(0)).rejects.toThrow("positive safe integer");
    expect(query).not.toHaveBeenCalled();
  });
});
