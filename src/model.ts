export interface SbxVersions {
  readonly client: string | null
  readonly server: string | null
}

export type AuthState = "authenticated" | "unauthenticated" | "unknown"

export type NetworkPolicyStatus = "initialized" | "required" | "unknown"
export type NetworkPolicyPreset = "balanced" | "allow-all" | "deny-all"

export interface PolicySetup {
  readonly preset: NetworkPolicyPreset | null
  readonly pending: boolean
  readonly error: string | null
}

export interface Diagnostics {
  readonly auth: AuthState
  readonly networkPolicy: NetworkPolicyStatus
}

export interface Sandbox {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly agent: string | null
  readonly workspaces: readonly string[]
}

export type SandboxAction = "start" | "stop" | "repair"

export const SECRET_SERVICES = [
  "anthropic", "copilot", "cursor", "devin", "droid", "github", "google", "groq", "mistral", "nebius", "openai", "openrouter", "xai",
] as const

export type SecretService = (typeof SECRET_SERVICES)[number]

export type SecretScope = "global" | "sandbox"

export interface StoredSecret {
  readonly scope: string
  readonly type: "service" | "custom"
  readonly name: string
  /** Local custom secrets are removed by placeholder, not by name. */
  readonly placeholder: string | null
}

export interface SecretSetup {
  /** Set while a create is in flight; the form stays disabled until it resolves. */
  readonly pending: boolean
  readonly error: string | null
  /** Set briefly after a successful create so the UI can confirm it. */
  readonly success: string | null
}

export interface SandboxOperation {
  readonly id: string
  readonly action: SandboxAction
  readonly pending: boolean
  readonly error: string | null
}

export function sandboxAction(status: string): "start" | "stop" | null {
  switch (statusTone(status)) {
    case "running": return "stop"
    case "stopped": return "start"
    default: return null
  }
}

export type InventoryErrorCode =
  | "missing-cli"
  | "timeout"
  | "daemon-restart-required"
  | "command-failed"
  | "invalid-output"
  | "not-signed-in"
  | "network-policy-required"

export interface InventoryError {
  readonly code: InventoryErrorCode
  readonly message: string
}

export interface Inventory {
  readonly sandboxes: readonly Sandbox[]
  readonly refreshing: boolean
  readonly updatedAt: number | null
  readonly error: InventoryError | null
  readonly versions: SbxVersions | null
  readonly auth: AuthState | null
  readonly networkPolicy: NetworkPolicyStatus | null
  readonly login: { readonly url: string | null; readonly code: string | null } | null
  readonly secrets: readonly StoredSecret[]
  readonly secretSetup: SecretSetup
}

export function statusTone(status: string): "running" | "stopped" | "other" {
  switch (status.toLowerCase()) {
    case "running":
      return "running"
    case "stopped":
      return "stopped"
    default:
      return "other"
  }
}
