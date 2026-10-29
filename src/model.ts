export interface Sandbox {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly agent: string | null
  readonly workspaces: readonly string[]
}

export type SandboxAction = "start" | "stop"

export interface SandboxOperation {
  readonly id: string
  readonly action: SandboxAction
  readonly pending: boolean
  readonly error: string | null
}

export function sandboxAction(status: string): SandboxAction | null {
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

export interface InventoryError {
  readonly code: InventoryErrorCode
  readonly message: string
}

export interface Inventory {
  readonly sandboxes: readonly Sandbox[]
  readonly refreshing: boolean
  readonly updatedAt: number | null
  readonly error: InventoryError | null
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
