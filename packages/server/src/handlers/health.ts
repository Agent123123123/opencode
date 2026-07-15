import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const HealthHandler = HttpApiBuilder.group(Api, "server.health", (handlers) =>
  handlers.handle("health.get", () =>
    Effect.succeed({
      healthy: true as const,
      capabilities: {
        sessionCreateByID: true,
        durableInputIdempotency: true,
        inputDeliveryQueue: true,
        sessionEventReplay: true,
        toolExecutionIdentity: true,
        transportActivityEvents: false,
        activitySettlement: false,
        targetedInterrupt: false,
      },
    })),
)
