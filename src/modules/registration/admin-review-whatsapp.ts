import { appError, err, ok, type Result } from "../../shared-kernel/result.js";
import type { MessageHandlerContext, MessageHandlerResult } from "../messaging/contracts.js";
import type { MessageRouteHandler } from "../messaging/ports.js";
import type { CommandRouteDefinition } from "../messaging/router.js";
import type { AuditedRegistrationReviewService } from "./admin-review-service.js";
import type { RegistrationRevisionRecord, RegistrationRevisionStatus } from "./ports.js";

interface RegistrationReviewMessageRef {
  readonly provider: string;
  readonly providerExternalMessageId: string;
  readonly outboxMessageId: string;
  readonly reviewId: string;
  readonly reviewRevision: number;
}

interface RegistrationReviewMessageRefReader {
  findByProviderMessage(input: {
    readonly provider: string;
    readonly providerExternalMessageId: string;
  }): Promise<RegistrationReviewMessageRef | null>;
}

interface RegistrationAdminPrincipalResolver {
  resolvePrincipal(input: {
    readonly provider: string;
    readonly externalId: string;
  }): Promise<{ readonly principalId: string } | null>;
}

interface RegistrationReviewDisplaySetup {
  readonly regionId: string;
  readonly regionDisplayName: string;
  readonly starterOptions: readonly {
    readonly formId: string;
    readonly displayName: string;
  }[];
}

interface RegistrationReviewDisplaySetupLoader {
  load(): Promise<Result<RegistrationReviewDisplaySetup>>;
}

export interface RegistrationAdminWhatsAppDependencies {
  readonly messageRefs: RegistrationReviewMessageRefReader;
  readonly admins: RegistrationAdminPrincipalResolver;
  readonly registration: Pick<
    AuditedRegistrationReviewService,
    "getReview" | "requestChanges" | "approve" | "reject"
  >;
  readonly setup?: RegistrationReviewDisplaySetupLoader;
}

type Handler = (context: MessageHandlerContext) => Promise<Result<MessageHandlerResult>>;

class FunctionalHandler implements MessageRouteHandler {
  public constructor(private readonly fn: Handler) {}

  public handle(context: MessageHandlerContext): Promise<Result<MessageHandlerResult>> {
    return this.fn(context);
  }
}

function reviewReply(
  context: MessageHandlerContext,
  reviewId: string,
  text: string,
): Result<MessageHandlerResult> {
  return ok({
    resultRefType: "REGISTRATION_REVIEW",
    resultRefId: reviewId,
    outgoing: [
      {
        channel: "whatsapp",
        destinationRef: context.message.chatRef,
        messageType: "TEXT",
        payload: { text },
        idempotencyKey: `${context.idempotencyKey}:registration-admin-reply`,
      },
    ],
  });
}

function statusDisplayName(status: RegistrationRevisionStatus): string {
  switch (status) {
    case "SUBMITTED":
      return "Em análise";
    case "CHANGES_REQUESTED":
      return "Ajustes solicitados";
    case "APPROVED":
      return "Aprovada";
    case "REJECTED":
      return "Rejeitada";
    case "WITHDRAWN":
      return "Retirada";
  }
}

function starterDisplayName(
  review: RegistrationRevisionRecord,
  setup: RegistrationReviewDisplaySetup | undefined,
): string {
  if (setup === undefined) return "Selecionado";
  return (
    setup.starterOptions.find((option) => option.formId === review.snapshot.starterFormId)
      ?.displayName ?? "Selecionado"
  );
}

function regionDisplayName(
  review: RegistrationRevisionRecord,
  setup: RegistrationReviewDisplaySetup | undefined,
): string {
  return setup?.regionId === review.snapshot.regionId ? setup.regionDisplayName : "Configurada";
}

function reviewText(
  review: RegistrationRevisionRecord,
  setup: RegistrationReviewDisplaySetup | undefined,
): string {
  return [
    `📋 *FICHA #${review.sequenceNo}*`,
    `Situação: ${statusDisplayName(review.status)}`,
    "",
    `Nome: ${review.snapshot.trainerName}`,
    `Idade: ${review.snapshot.age}`,
    `Gênero / pronomes: ${review.snapshot.genderPronouns}`,
    `Aparência: ${review.snapshot.appearance}`,
    `Personalidade: ${review.snapshot.personality}`,
    `História / resumo: ${review.snapshot.backstory}`,
    `Pokémon inicial: ${starterDisplayName(review, setup)}`,
    `Região: ${regionDisplayName(review, setup)}`,
  ].join("\n");
}

async function resolveReplyRef(
  dependencies: RegistrationAdminWhatsAppDependencies,
  context: MessageHandlerContext,
): Promise<Result<RegistrationReviewMessageRef>> {
  const replyToExternalMessageId = context.message.replyToExternalMessageId;
  if (replyToExternalMessageId === null) {
    return err(
      appError(
        "ACTION_INVALID",
        "Administrative registration review command must reply to a review notification",
      ),
    );
  }

  const reference = await dependencies.messageRefs.findByProviderMessage({
    provider: context.message.provider,
    providerExternalMessageId: replyToExternalMessageId,
  });
  return reference === null
    ? err(appError("NOT_FOUND", "Registration review notification was not found"))
    : ok(reference);
}

async function resolveAdminPrincipal(
  dependencies: RegistrationAdminWhatsAppDependencies,
  context: MessageHandlerContext,
): Promise<Result<string>> {
  const principal = await dependencies.admins.resolvePrincipal({
    provider: context.message.provider,
    externalId: context.message.senderRef,
  });
  return principal === null
    ? err(appError("PLAYER_INELIGIBLE", "Administrative principal is required"))
    : ok(principal.principalId);
}

function reviewPolicy(capability: string) {
  return {
    requiredGroupCapabilities: ["admin.review"],
    requiredAdminCapability: capability,
  } as const;
}

type Decision = "APPROVE" | "REQUEST_CHANGES" | "REJECT";

async function decide(
  dependencies: RegistrationAdminWhatsAppDependencies,
  context: MessageHandlerContext,
  decision: Decision,
): Promise<Result<MessageHandlerResult>> {
  const reference = await resolveReplyRef(dependencies, context);
  if (!reference.ok) return reference;

  const principal = await resolveAdminPrincipal(dependencies, context);
  if (!principal.ok) return principal;

  const input = {
    principalId: principal.value,
    reviewId: reference.value.reviewId,
    expectedRevision: reference.value.reviewRevision,
    idempotencyKey: `${context.idempotencyKey}:registration-review:${decision.toLocaleLowerCase()}`,
    correlationId: context.correlationId,
    sourceChannel: "WHATSAPP" as const,
  };

  const result =
    decision === "APPROVE"
      ? await dependencies.registration.approve(input)
      : decision === "REQUEST_CHANGES"
        ? await dependencies.registration.requestChanges(input)
        : await dependencies.registration.reject(input);
  if (!result.ok) return result;

  const text =
    decision === "APPROVE"
      ? "✅ Ficha aprovada. A liberação do treinador foi iniciada."
      : decision === "REQUEST_CHANGES"
        ? "📝 Ajustes solicitados. A ficha poderá ser reaberta preservando os dados enviados."
        : "⛔ Ficha rejeitada.";
  return reviewReply(context, result.value.id, text);
}

export function createRegistrationAdminWhatsAppRoutes(
  dependencies: RegistrationAdminWhatsAppDependencies,
): readonly CommandRouteDefinition[] {
  const view = new FunctionalHandler(async (context) => {
    const reference = await resolveReplyRef(dependencies, context);
    if (!reference.ok) return reference;
    const principal = await resolveAdminPrincipal(dependencies, context);
    if (!principal.ok) return principal;
    const review = await dependencies.registration.getReview({
      principalId: principal.value,
      reviewId: reference.value.reviewId,
      sourceChannel: "WHATSAPP",
    });
    if (!review.ok) return review;

    let setup: RegistrationReviewDisplaySetup | undefined;
    if (dependencies.setup !== undefined) {
      const loaded = await dependencies.setup.load();
      if (!loaded.ok) return err(loaded.error);
      setup = loaded.value;
    }

    return reviewReply(context, review.value.id, reviewText(review.value, setup));
  });

  return [
    {
      command: "verficha",
      handler: view,
      policy: reviewPolicy("player.registration.read"),
    },
    {
      command: "aprovar",
      handler: new FunctionalHandler((context) => decide(dependencies, context, "APPROVE")),
      rateLimitClass: "SENSITIVE",
      policy: reviewPolicy("player.registration.approve"),
    },
    {
      command: "ajustes",
      handler: new FunctionalHandler((context) => decide(dependencies, context, "REQUEST_CHANGES")),
      rateLimitClass: "SENSITIVE",
      policy: reviewPolicy("player.registration.request_changes"),
    },
    {
      command: "rejeitar",
      handler: new FunctionalHandler((context) => decide(dependencies, context, "REJECT")),
      rateLimitClass: "SENSITIVE",
      policy: reviewPolicy("player.registration.reject"),
    },
  ];
}
