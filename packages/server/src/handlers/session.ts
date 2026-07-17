import { SessionV2 } from "@opencode-ai/core/session"
import { DateTime, Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "../groups/session"
import {
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { SessionSelection } from "@opencode-ai/core/session/selection"

const DefaultSessionsLimit = 50

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const events = yield* EventV2.Service
    const locations = yield* LocationServiceMap

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          const location = ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) }
          const selection = yield* SessionSelection.Service.use((service) =>
            service.resolve({ agent: ctx.payload.agent, model: ctx.payload.model }),
          ).pipe(
            Effect.provide(locations.get(location)),
            Effect.catchTags({
              "SessionSelection.AgentNotFoundError": (error) =>
                Effect.fail(new InvalidRequestError({ message: `Unknown agent: ${error.agent}`, field: "agent" })),
              "SessionSelection.ModelNotSelectedError": () =>
                Effect.fail(
                  new ServiceUnavailableError({ message: "No supported model is available", service: "catalog" }),
                ),
              "SessionSelection.ModelUnsupportedError": (error) =>
                Effect.fail(
                  new InvalidRequestError({
                    message: `Unsupported model: ${error.model.providerID}/${error.model.id}`,
                    field: "model",
                  }),
                ),
              "SessionSelection.VariantNotFoundError": (error) =>
                Effect.fail(
                  new InvalidRequestError({
                    message: `Unknown model variant: ${error.model.variant}`,
                    field: "model.variant",
                  }),
                ),
              "CatalogV2.ProviderNotFound": (error) =>
                Effect.fail(
                  new InvalidRequestError({ message: `Unknown provider: ${error.providerID}`, field: "model.providerID" }),
                ),
              "CatalogV2.ModelNotFound": (error) =>
                Effect.fail(
                  new InvalidRequestError({ message: `Unknown model: ${error.modelID}`, field: "model.id" }),
                ),
            }),
          )
          const created = yield* session.create({
            id: ctx.payload.id,
            title: ctx.payload.title,
            agent: selection.agent,
            model: selection.model,
            location,
          })
          if (
            created.agent !== selection.agent ||
            created.model?.id !== selection.model.id ||
            created.model.providerID !== selection.model.providerID ||
            created.model.variant !== selection.model.variant ||
            (ctx.payload.title !== undefined && created.title !== ctx.payload.title)
          )
            return yield* new ConflictError({
              message: `Session ${created.id} already exists with a different title, agent, or model selection`,
              resource: created.id,
            })
          return {
            data: created,
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.events",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
          )
          const history = yield* events.aggregateHistory({
            aggregateID: ctx.params.sessionID,
            after: ctx.query.after,
            limit: Math.min(ctx.query.limit ?? 200, 1000),
          })
          return {
            data: history.map(({ cursor, event }) => ({
              cursor,
              event: {
                id: event.id,
                type: event.type,
                version: event.version,
                data: event.data,
              },
            })),
          }
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.OperationUnavailableError", (error) =>
              Effect.fail(
                new ServiceUnavailableError({
                  message: `Session ${error.operation} is not available yet`,
                  service: `session.${error.operation}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
  }),
)
