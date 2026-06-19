export type FeatureVisibility = "show" | "hide" | "rename" | "demote" | "replace" | "confirm"

export type IcFeatureID =
  | "ic.workflow"
  | "ic.lane"
  | "ic.agent"
  | "ic.session"
  | "ic.diagnostic"
  | "ic.evidence"
  | "native.session.open"
  | "native.session.list"
  | "native.child-session.top-level"
  | "native.command-log"

export type IcFeaturePolicyRule = {
  feature: IcFeatureID
  visibility: FeatureVisibility
  label: string
  reason: string
}

export type IcFeaturePolicy = Record<IcFeatureID, IcFeaturePolicyRule>

export const defaultIcFeaturePolicy: IcFeaturePolicy = {
  "ic.workflow": {
    feature: "ic.workflow",
    visibility: "show",
    label: "Workflow",
    reason: "Workflow state is a first-class IC Agent product concept.",
  },
  "ic.lane": {
    feature: "ic.lane",
    visibility: "show",
    label: "Lane board",
    reason: "Lanes are primarily understood as workflow progress rows with dependency hints.",
  },
  "ic.agent": {
    feature: "ic.agent",
    visibility: "hide",
    label: "Agents",
    reason: "Agents are implementation details behind workflow progress, not user-facing navigation.",
  },
  "ic.session": {
    feature: "ic.session",
    visibility: "hide",
    label: "Workflow sessions",
    reason: "Workflow-bound session IDs are internal routing details and should not be shown by default.",
  },
  "ic.diagnostic": {
    feature: "ic.diagnostic",
    visibility: "demote",
    label: "Blockers",
    reason: "Workflow health appears as lane board and lane context, not a default blocker tab.",
  },
  "ic.evidence": {
    feature: "ic.evidence",
    visibility: "demote",
    label: "Artifacts",
    reason: "Regression docs, logs, and reports are opened on demand from lane context.",
  },
  "native.session.open": {
    feature: "native.session.open",
    visibility: "demote",
    label: "Open native session",
    reason: "Native OpenCode remains available as an escape hatch, but IC focus owns the shell.",
  },
  "native.session.list": {
    feature: "native.session.list",
    visibility: "demote",
    label: "Native session list",
    reason: "Secondary sessions are reached through IC workflow context first.",
  },
  "native.child-session.top-level": {
    feature: "native.child-session.top-level",
    visibility: "hide",
    label: "Top-level child sessions",
    reason: "Child sessions should not be startup entry points in IC Agent mode.",
  },
  "native.command-log": {
    feature: "native.command-log",
    visibility: "hide",
    label: "Command log",
    reason: "IC commands are modeled as actions, not displayed as a passive log.",
  },
}

export function icFeature(feature: IcFeatureID, policy: IcFeaturePolicy = defaultIcFeaturePolicy) {
  return policy[feature]
}

export function icFeatureVisible(feature: IcFeatureID, policy: IcFeaturePolicy = defaultIcFeaturePolicy) {
  const visibility = icFeature(feature, policy).visibility
  return visibility !== "hide"
}
