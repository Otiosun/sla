import { createHash, randomBytes } from "node:crypto";
import { ExternalIdentitySchema, type ExternalIdentity } from "../player/contracts.js";
import { appError, err, ok, type Result } from "../../shared-kernel/result.js";

const HUB_LOGIN_TICKET_TTL_MS = 5 * 60 * 1000;
const HUB_LOGIN_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface HubLoginTicketRecord {
  readonly ticketHash: string;
  readonly identity: ExternalIdentity;
  readonly expiresAt: Date;
}

export interface HubLoginTicketStore {
  issue(record: HubLoginTicketRecord): Promise<void>;
  consume(input: {
    readonly ticketHash: string;
    readonly now: Date;
  }): Promise<ExternalIdentity | null>;
}

export interface HubLoginTicketIssueResult {
  readonly ticket: string;
  readonly expiresAt: Date;
}

interface HubLoginTicketDependencies {
  readonly now?: () => Date;
  readonly generateToken?: () => string;
}

export class HubLoginTicketService {
  private readonly now: () => Date;
  private readonly generateToken: () => string;

  public constructor(
    private readonly store: HubLoginTicketStore,
    dependencies: HubLoginTicketDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.generateToken =
      dependencies.generateToken ?? (() => randomBytes(32).toString("base64url"));
  }

  public async issue(identity: ExternalIdentity): Promise<Result<HubLoginTicketIssueResult>> {
    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return err(appError("VALIDATION_FAILED", "Invalid external identity"));
    }

    const ticket = this.generateToken();
    if (!HUB_LOGIN_TICKET_PATTERN.test(ticket)) {
      return err(appError("VALIDATION_FAILED", "Invalid generated Hub login ticket"));
    }

    const now = this.now();
    const expiresAt = new Date(now.getTime() + HUB_LOGIN_TICKET_TTL_MS);
    await this.store.issue({
      ticketHash: hashTicket(ticket),
      identity: parsedIdentity.data,
      expiresAt,
    });

    return ok({ ticket, expiresAt });
  }

  public async redeem(ticket: string): Promise<Result<ExternalIdentity>> {
    if (!HUB_LOGIN_TICKET_PATTERN.test(ticket)) {
      return err(appError("VALIDATION_FAILED", "Invalid Hub login ticket"));
    }

    const identity = await this.store.consume({
      ticketHash: hashTicket(ticket),
      now: this.now(),
    });
    if (identity === null) {
      return err(appError("NOT_FOUND", "Hub login ticket unavailable"));
    }

    const parsedIdentity = ExternalIdentitySchema.safeParse(identity);
    if (!parsedIdentity.success) {
      return err(appError("NOT_FOUND", "Hub login ticket unavailable"));
    }

    return ok(parsedIdentity.data);
  }
}

function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}
