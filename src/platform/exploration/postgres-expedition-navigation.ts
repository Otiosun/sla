import type { Pool } from "pg";
import { z } from "zod";
import type {
  MessageHandlerContext,
  MessageHandlerResult,
} from "../../modules/messaging/contracts.js";
import type { PlayerRegistrationService } from "../../modules/player/registration-service.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

const anchor = z
  .object({
    originChat: z.string().regex(/^[0-9]+(?:-[0-9]+)?@g\.us$/),
    playerId: z.string().uuid(),
    expeditionId: z.string().uuid().nullable(),
    revision: z.string().regex(/^\d+$/).nullable(),
    areaId: z.string().uuid(),
    weekKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    commands: z.record(
      z.string().regex(/^[1-5]$/),
      z.enum([
        "/explorar dia",
        "/explorar noite",
        "/explorar buscar",
        "/explorar recursos",
        "/explorar destinos",
        "/explorar encerrar",
        "/explorar alterar",
        "/explorar cancelar",
        "/explorar periodo dia",
        "/explorar periodo noite",
      ]),
    ),
  })
  .strict();
/** Only a delivered private panel can authorize its own numeric options. */
export class PostgresExpeditionNavigation {
  constructor(
    private readonly pool: Pool,
    private readonly players: Pick<PlayerRegistrationService, "resolvePlayer">,
    private readonly dispatch: (
      context: MessageHandlerContext,
    ) => Promise<Result<MessageHandlerResult | null>>,
  ) {}
  async resolve(context: MessageHandlerContext): Promise<Result<MessageHandlerResult | null>> {
    const input = context.message;
    if (input.provider !== "baileys") return ok(null);
    if (
      !/^[1-5]$/u.test(input.text?.trim() ?? "") ||
      input.replyToExternalMessageId === null ||
      input.chatRef !== input.senderRef
    )
      return ok(null);
    const found = await this.pool.query<{ payload: unknown }>(
      "SELECT payload->'expeditionNavigation' AS payload FROM outbox_messages WHERE channel='whatsapp' AND destination_ref=$1 AND status='SENT' AND upper(replace(id::text,'-',''))=upper($2) AND payload ? 'expeditionNavigation'",
      [input.senderRef, input.replyToExternalMessageId],
    );
    if (found.rows.length === 0) return ok(null);
    const parsed = anchor.safeParse(found.rows[0]?.payload);
    if (!parsed.success || input.forwarded)
      return err(appError("FLOW_BLOCKED", "Use uma opção do seu menu atual de exploração."));
    const player = await this.players.resolvePlayer({
      provider: input.provider,
      externalId: input.senderRef,
    });
    if (!player.ok) return player;
    if (player.value.state !== "COMPLETE" || player.value.playerId !== parsed.data.playerId)
      return err(appError("PLAYER_INELIGIBLE", "Esse menu pertence a outro treinador."));
    const command = parsed.data.commands[input.text!.trim()];
    if (!command)
      return err(appError("VALIDATION_FAILED", "Essa opção não foi oferecida no menu citado."));
    // Delegate only to the panel's trusted group. Router + handler recheck its
    // CURRENT group capabilities and actor access; no public reply is produced.
    return this.dispatch({
      ...context,
      expeditionNavigationAuthorization: parsed.data,
      originalMessageText: context.originalMessageText ?? input.text,
      message: { ...input, chatRef: parsed.data.originChat, text: command },
    });
  }
}
