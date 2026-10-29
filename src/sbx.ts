import { execFile } from "node:child_process"
import type { InventoryError, Sandbox } from "./model"

export const CLI_TIMEOUT_MS = 10_000
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export class SbxError extends Error {
  constructor(readonly detail: InventoryError) {
    super(detail.message)
    this.name = "SbxError"
  }
}

function invalidOutput(): never {
  throw new SbxError({
    code: "invalid-output",
    message: "sbx returned an unexpected response. Check `sbx ls --format json` in a terminal and your sbx version.",
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

export function parseSandboxes(output: string): Sandbox[] {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return invalidOutput()
  }
  if (!Array.isArray(value)) return invalidOutput()

  const ids = new Set<string>()
  return value.map((item: unknown) => {
    if (!record(item) || !nonempty(item.id) || !nonempty(item.name) || !nonempty(item.status)) {
      return invalidOutput()
    }
    if (ids.has(item.id)) return invalidOutput()
    ids.add(item.id)
    if (item.agent != null && typeof item.agent !== "string") return invalidOutput()
    const workspaces: unknown = item.workspaces ?? []
    if (!Array.isArray(workspaces) || !workspaces.every((path: unknown) => typeof path === "string")) {
      return invalidOutput()
    }

    return {
      id: item.id,
      name: item.name,
      status: item.status,
      agent: typeof item.agent === "string" && item.agent ? item.agent : null,
      workspaces: workspaces as string[],
    }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

interface ProcessFailure {
  code?: string | number | null
  killed?: boolean
  name?: string
}

export function commandError(error: ProcessFailure, stderr = ""): SbxError {
  if (error.code === "ENOENT") {
    return new SbxError({
      code: "missing-cli",
      message: "Cannot find sbx. Install Docker Sandboxes, or set the plugin's sbxPath option to its absolute executable path.",
    })
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new SbxError({
      code: "invalid-output",
      message: "sbx output exceeded the panel's size limit. Check `sbx ls --format json` in a terminal.",
    })
  }
  if (error.killed) {
    return new SbxError({
      code: "timeout",
      message: "sbx did not respond within 10 seconds. Check Docker Sandboxes in a terminal, then refresh.",
    })
  }
  if (/needs to restart|cannot prompt for restart|client.*server.*version mismatch/i.test(stderr)) {
    return new SbxError({
      code: "daemon-restart-required",
      message: "The sbx daemon needs to restart after an update. Run `sbx daemon restart` in a terminal; this stops running sandboxes.",
    })
  }
  // Keep raw stderr out of the UI/logs: it can contain local paths or other sensitive details.
  return new SbxError({
    code: "command-failed",
    message: "Could not list sandboxes. Run `sbx ls --format json` in a terminal to check the daemon and CLI, then refresh.",
  })
}

export interface ListOptions {
  readonly executable: string
  readonly signal: AbortSignal
}

export function listSandboxes({ executable, signal }: ListOptions): Promise<Sandbox[]> {
  return new Promise((resolve, reject) => {
    execFile(executable, ["ls", "--format", "json"], {
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      signal,
    }, (error, stdout, stderr) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("Sandbox refresh cancelled"))
        return
      }
      if (error) {
        reject(commandError(error, stderr))
        return
      }
      try {
        resolve(parseSandboxes(stdout))
      } catch (error) {
        reject(error)
      }
    })
  })
}
