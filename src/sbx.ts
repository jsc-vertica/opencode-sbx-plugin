import { execFile } from "node:child_process"
import type { InventoryError, Sandbox, SandboxAction } from "./model"

export const CLI_TIMEOUT_MS = 10_000
export const ACTION_TIMEOUT_MS = 60_000
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export interface SbxVersions {
  readonly client: string | null
  readonly server: string | null
}

/** Extracts "v0.50.1" from CLI output, tolerating prefixes, revisions, and surrounding text. */
export function parseVersions(output: string): SbxVersions {
  let client: string | null = null
  let server: string | null = null
  for (const section of ["client", "server"] as const) {
    const match = new RegExp(`"${section}"\\s*:\\s*\\{[^{}]*?"version"\\s*:\\s*"([^"\\s]+)"`).exec(output)
    const version = match?.[1]?.replace(/^v/, "") ?? null
    if (section === "client") client = version
    else server = version
  }
  if (client === null && server === null) {
    client = /v?(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
  }
  return { client, server }
}

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

export function commandError(error: ProcessFailure, stderr = "", options = {
  timeout: CLI_TIMEOUT_MS,
  failureMessage: "Could not list sandboxes. Run `sbx ls --format json` in a terminal to check the daemon and CLI, then refresh.",
}): SbxError {
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
      message: `sbx did not respond within ${options.timeout / 1000} seconds. The command may have partially completed; refresh to check the sandbox status before retrying.`,
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
    message: options.failureMessage,
  })
}

export interface ListOptions {
  readonly executable: string
  readonly signal: AbortSignal
}

export function listSandboxes({ executable, signal }: ListOptions): Promise<Sandbox[]> {
  return executeSbx({ executable, signal }, ["ls", "--format", "json"]).then(parseSandboxes)
}

export function readVersions(options: ListOptions): Promise<SbxVersions> {
  return executeSbx(options, ["version", "--format", "json"]).then(parseVersions)
}

export async function changeSandbox(options: ListOptions, sandbox: Sandbox, action: SandboxAction): Promise<void> {
  const args = action === "start"
    ? ["run", "--detach", "--name", sandbox.name]
    : ["stop", "--", sandbox.name]
  await executeSbx(options, args, {
    timeout: ACTION_TIMEOUT_MS,
    failureMessage: `Could not ${action} the sandbox. Check sbx in a terminal, then refresh to check its status before retrying.`,
  })
}

function executeSbx(
  { executable, signal }: ListOptions,
  args: string[],
  options?: { timeout: number; failureMessage: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, args, {
      encoding: "utf8",
      timeout: options?.timeout ?? CLI_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      signal,
    }, (error, stdout, stderr) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error("Sandbox refresh cancelled"))
        return
      }
      if (error) {
        reject(commandError(error, stderr, options))
        return
      }
      resolve(stdout)
    })
    // Lifecycle actions must never wait for interactive input.
    child.stdin?.end()
  })
}
