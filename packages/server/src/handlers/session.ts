import { SessionV2 } from "@opencode-ai/core/session"
import { DateTime, Effect, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@opencode-ai/protocol/groups/session"
import {
  ConflictError,
  InvalidRequestError,
  InvalidCursorError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "@opencode-ai/protocol/errors"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ManagedSessionAuthority } from "../managed-session-authority"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service

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
          if (ctx.payload.executionManaged === true) yield* ManagedSessionAuthority.assertController()
          const create = session
            .create({
              id: ctx.payload.id,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              executionManaged: ctx.payload.executionManaged,
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            })
            .pipe(
              Effect.catchTags({
                "SessionSelection.AgentNotFoundError": (error) =>
                  Effect.fail(new InvalidRequestError({ message: `Unknown agent: ${error.agent}`, field: "agent" })),
                "SessionSelection.AgentUnavailableError": (error) =>
                  Effect.fail(
                    new InvalidRequestError({ message: `Agent is not selectable: ${error.agent}`, field: "agent" }),
                  ),
                "SessionSelection.ModelNotSelectedError": () =>
                  Effect.fail(
                    new ServiceUnavailableError({ message: "No supported model is available", service: "catalog" }),
                  ),
                "SessionSelection.ModelUnavailableError": (error) =>
                  Effect.fail(
                    new InvalidRequestError({
                      message: `Unavailable model: ${error.model.providerID}/${error.model.id}`,
                      field: "model",
                    }),
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
                "Session.CreateConflictError": (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Session ${error.sessionID} already exists with a different ${error.reason}`,
                      resource: error.sessionID,
                    }),
                  ),
                "Session.ManagedSelectionRequiredError": (error) =>
                  Effect.fail(
                    new InvalidRequestError({
                      message: `Managed session creation requires an exact ${error.field}`,
                      field: error.field,
                    }),
                  ),
              }),
            )
          return { data: yield* create }
        }),
      )
      .handle(
        "session.executionGate",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.executionGate(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                })),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.executionGate.set",
        Effect.fn(function* (ctx) {
          if (ctx.payload.open) {
            yield* ManagedSessionAuthority.grant(ctx.params.sessionID)
          } else {
            yield* ManagedSessionAuthority.assertController()
            ManagedSessionAuthority.revoke(ctx.params.sessionID)
          }
          const data = yield* session.setExecutionGate({
              sessionID: ctx.params.sessionID,
              open: ctx.payload.open,
              reason: ctx.payload.reason,
            }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                })),
              ),
            )
          return { data }
        }),
      )
      .handle(
        "session.executionReset",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertController()
          ManagedSessionAuthority.revoke(ctx.params.sessionID)
          return {
            data: yield* session.resetExecution({
              sessionID: ctx.params.sessionID,
              request: ctx.payload,
            }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                })),
              ),
              Effect.catchTag("SessionReset.Conflict", (error) =>
                Effect.fail(new ConflictError({ message: error.reason, resource: error.sessionID })),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.inputAuthorization.authorize",
        Effect.fn(function* (ctx) {
          const info = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(new SessionNotFoundError({
                sessionID: error.sessionID,
                message: `Session not found: ${error.sessionID}`,
              })),
            ),
          )
          if (!info.execution.managed) {
            return yield* new InvalidRequestError({
              message: "Input-scoped execution grants require a managed Session",
              field: "sessionID",
            })
          }
          const outcome = yield* ManagedSessionAuthority.authorizeInput({
            sessionID: ctx.params.sessionID,
            inputID: ctx.params.inputID,
            claimID: ctx.payload.claimID,
            cell: ctx.payload.cell,
            managedExecutionRef: ctx.payload.managedExecutionRef,
          })
          if (outcome === "session_unauthorized") {
            return yield* new InvalidRequestError({
              message: "Managed Session must be reset and opened before an input can be authorized",
              field: "sessionID",
            })
          }
          if (outcome === "conflict") {
            return yield* new ConflictError({
              message: "Managed input authorization conflicts with the existing process-local grant",
              resource: ctx.params.inputID,
            })
          }
          yield* session.setExecutionGate({
            sessionID: ctx.params.sessionID,
            open: true,
            reason: `managed_input_authorized:${ctx.payload.claimID}`,
          }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(new SessionNotFoundError({
                sessionID: error.sessionID,
                message: `Session not found: ${error.sessionID}`,
              })),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.inputAuthorization.unauthorize",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(new SessionNotFoundError({
                sessionID: error.sessionID,
                message: `Session not found: ${error.sessionID}`,
              })),
            ),
          )
          const outcome = yield* ManagedSessionAuthority.revokeInput({
            sessionID: ctx.params.sessionID,
            inputID: ctx.params.inputID,
            claimID: ctx.payload.claimID,
            cell: ctx.payload.cell,
          })
          if (outcome === "conflict") {
            return yield* new ConflictError({
              message: "Managed input revocation conflicts with the existing process-local grant",
              resource: ctx.params.inputID,
            })
          }
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          return {
            data: Object.fromEntries(
              Array.from(yield* session.active, (sessionID) => [sessionID, { type: "running" as const }]),
            ),
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
        "session.update",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
          return {
            data: yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title }).pipe(
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
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
          yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
          yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
            Effect.catchTags({
              "Session.NotFoundError": (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              "SessionSelection.ModelNotSelectedError": () =>
                Effect.fail(
                  new ServiceUnavailableError({ message: "No supported model is available", service: "catalog" }),
                ),
              "SessionSelection.ModelUnavailableError": (error) =>
                Effect.fail(
                  new InvalidRequestError({
                    message: `Unavailable model: ${error.model.providerID}/${error.model.id}`,
                    field: "model",
                  }),
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
            }),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          const info = yield* session.get(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
          )
          const controller = yield* ManagedSessionAuthority.isController()
          if (
            info.execution.managed && !controller &&
            (info.agent === "analyst" || info.agent === "coordinator" || info.agent === "checker")
          ) {
            return yield* new InvalidRequestError({
              message: "Direct user input is allowed only on the primary managed Session",
              field: "sessionID",
            })
          }
          if (info.execution.managed && controller) yield* ManagedSessionAuthority.assertController()
          if (!info.execution.managed) {
            yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
          }
          if (ctx.payload.completionContract && !info.execution.managed) {
            return yield* new InvalidRequestError({
              message: "Completion contracts require a managed session",
              field: "completionContract",
            })
          }
          if (ctx.payload.completionContract) yield* ManagedSessionAuthority.assertController()
          if (ctx.payload.completionContract && !ctx.payload.managedExecution) {
            return yield* new InvalidRequestError({
              message: "Managed controller input requires a managed execution reference",
              field: "managedExecution",
            })
          }
          if (ctx.payload.managedExecution) {
            const execution = ctx.payload.managedExecution
            if (
              execution.origin !== "FRAMEWORK"
            ) {
              return yield* new InvalidRequestError({
                message: "Managed controller input requires a complete FRAMEWORK execution reference",
                field: "managedExecution",
              })
            }
          }
          if (ctx.payload.managedExecution && !ctx.payload.completionContract) {
            return yield* new InvalidRequestError({
              message: "Managed execution reference requires a controller completion contract",
              field: "managedExecution",
            })
          }
          if (info.execution.managed && controller && !ctx.payload.completionContract) {
            return yield* new InvalidRequestError({
              message: "Managed controller input requires an explicit completion contract",
              field: "completionContract",
            })
          }
          if (info.execution.managed && controller && ctx.payload.id === undefined) {
            return yield* new InvalidRequestError({
              message: "Managed controller input requires an explicit input ID",
              field: "id",
            })
          }
          if (
            info.execution.managed && controller && ctx.payload.managedExecution &&
            !ManagedSessionAuthority.hasInput({
              sessionID: ctx.params.sessionID,
              inputID: ctx.payload.id!,
              managedExecutionRef: ctx.payload.managedExecution,
            })
          ) {
            return yield* new InvalidRequestError({
              message: "Managed controller input lacks an exact current-process input grant",
              field: "id",
            })
          }
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                completionContract: ctx.payload.completionContract,
                managedExecution: ctx.payload.managedExecution,
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
                Effect.catchTag("Session.ManagedInputError", (error) =>
                  Effect.fail(
                    new InvalidRequestError({
                      message: error.reason === "steer_not_allowed"
                        ? "Managed sessions accept queued inputs only"
                        : "Completion contracts require a managed session",
                      field: error.reason === "steer_not_allowed" ? "delivery" : "completionContract",
                    }),
                  ),
                ),
                Effect.catchTags({
                  "SessionSelection.ModelNotSelectedError": () =>
                    Effect.fail(
                      new ServiceUnavailableError({ message: "Managed session has no selected model", service: "catalog" }),
                    ),
                  "SessionSelection.ModelUnavailableError": (error) =>
                    Effect.fail(
                      new InvalidRequestError({
                        message: `Unavailable model: ${error.model.providerID}/${error.model.id}`,
                        field: "model",
                      }),
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
                }),
              ),
          }
        }),
      )
      .handle(
        "session.input",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.input({
              sessionID: ctx.params.sessionID,
              inputID: ctx.params.inputID,
            }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                })),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.input.cancel",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
          return {
            data: yield* session.cancelInput({
              sessionID: ctx.params.sessionID,
              inputID: ctx.params.inputID,
              origin: ctx.payload.origin,
              reason: ctx.payload.reason,
            }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                })),
              ),
              Effect.catchTag("Session.PromptConflictError", (error) =>
                Effect.fail(new ConflictError({
                  message: `Input cancellation conflicts with durable state: ${error.messageID}`,
                  resource: error.messageID,
                })),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
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
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
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
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
          return {
            data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag(
                "Session.MessageNotFoundError",
                (error) =>
                  new MessageNotFoundError({
                    sessionID: error.sessionID,
                    messageID: error.messageID,
                    message: `Message not found: ${error.messageID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
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
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
          yield* session.revert.clear(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
            ),
            Effect.catchTag("Snapshot.Error", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
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
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
          yield* session.revert.commit(ctx.params.sessionID).pipe(
            Effect.catchTag(
              "Session.NotFoundError",
              (error) =>
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
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
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            ),
          }
        }),
      )
      .handle(
        "session.history",
        Effect.fn(function* (ctx) {
          return yield* session
            .history({
              sessionID: ctx.params.sessionID,
              after: ctx.query.after,
              limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
            })
            .pipe(
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
        }),
      )
      .handle(
        "session.events",
        Effect.fn((ctx) =>
          Effect.succeed(
            session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie),
          ),
        ),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          yield* ManagedSessionAuthority.assertWrite(session, ctx.params.sessionID)
          const accepted = yield* session.interruptExact({
            sessionID: ctx.params.sessionID,
            turnID: ctx.payload.turnID,
          })
          if (!accepted) {
            return yield* new ConflictError({
              message: "Exact turn is not the active execution",
              resource: ctx.payload.turnID,
            })
          }
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
  }),
)
