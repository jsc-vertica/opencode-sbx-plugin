import { execFile } from "node:child_process"
import type { Diagnostics, InventoryError, NetworkPolicyPreset, NetworkPolicyStatus, Sandbox, SandboxAction, SecretScope, SbxVersions, StoredSecret } from "./model"

export const CLI_TIMEOUT_MS = 10_000
export const ACTION_TIMEOUT_MS = 60_000
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Reads authentication and one-time network policy setup from `sbx diagnose --format json`.
 * Only a passing "authenticated" report counts as signed in; failures, skips,
 * and unknown check names are all reported as unknown rather than signed out.
 */
export function parseDiagnostics(output: string): Diagnostics {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return { auth: "unknown", networkPolicy: "unknown" }
  }
  if (!record(value) || !Array.isArray(value.checks)) return { auth: "unknown", networkPolicy: "unknown" }
  const check = value.checks.find((item: unknown) => record(item) && item.name === "Authentication")
  const policy = value.checks.find((item: unknown) => record(item) && item.name === "Global network policy")
  let networkPolicy: NetworkPolicyStatus = "unknown"
  if (record(policy)) {
    if (policy.status === "pass" && policy.message === "initialized") networkPolicy = "initialized"
    else if ((policy.status === "warn" || policy.status === "fail")
      && /\bnot initialized\b|\bhas not been initialized\b/i.test(String(policy.message))) networkPolicy = "required"
  }
  const auth = !record(check) || check.status !== "pass" ? "unknown"
    : /not authenticated|signed out|logged out/i.test(String(check.message))
    ? "unauthenticated"
    : "authenticated"
  return { auth, networkPolicy }
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
  if (/not signed in|try: sbx login/i.test(stderr)) {
    return new SbxError({
      code: "not-signed-in",
      message: "Not signed in to Docker. Sign in to list your sandboxes.",
    })
  }
  if (/policy[._]not_initialized|global network policy (?:has not been|is not) initialized/i.test(stderr)) {
    return new SbxError({
      code: "network-policy-required",
      message: "Choose a network policy in this panel before starting a sandbox, or run `sbx policy init <allow-all|balanced|deny-all>` in a terminal.",
    })
  }
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

export function readDiagnostics(options: ListOptions): Promise<Diagnostics> {  return executeSbx(options, ["diagnose", "--format", "json"], {
    timeout: CLI_TIMEOUT_MS,
    failureMessage: "Could not read sbx diagnostics. Run `sbx diagnose --format json` in a terminal.",
    // diagnose can exit nonzero precisely because policy setup is required.
    acceptFailureOutput: (output) => {
      try {
        const report: unknown = JSON.parse(output)
        return record(report) && Array.isArray(report.checks)
      } catch {
        return false
      }
    },
  }).then(parseDiagnostics)
}

export async function initializeNetworkPolicy(options: ListOptions, preset: NetworkPolicyPreset): Promise<void> {
  if (!["balanced", "allow-all", "deny-all"].includes(preset)) throw new Error("Unsupported network policy preset")
  // Initialization only: never reset or replace an existing policy.
  await executeSbx(options, ["policy", "init", preset], {
    timeout: ACTION_TIMEOUT_MS,
    failureMessage: "Could not initialize the network policy. Refresh to check its status, then retry. Existing policies are never reset by this panel.",
  })
}

export const LOGIN_TIMEOUT_MS = 10 * 60_000

/** Parses `sbx secret ls --format json`, keeping only the non-sensitive fields. */
export function parseSecrets(output: string): StoredSecret[] {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return invalidOutput()
  }
  if (!record(value) || !Array.isArray(value.secrets)) return invalidOutput()
  return value.secrets.map((item: unknown) => {
    if (!record(item) || !nonempty(item.name) || !nonempty(item.scope)) return invalidOutput()
    return { name: item.name, scope: item.scope, type: typeof item.type === "string" && item.type ? item.type : "service" }
  }).sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name))
}

export function listSecrets(options: ListOptions): Promise<StoredSecret[]> {
  return executeSbx(options, ["secret", "ls", "--format", "json"]).then(parseSecrets)
}

/**
 * Creates or updates a predefined service secret. The value goes through stdin
 * (`--password-stdin`-style) rather than argv so it is not visible in the process list.
 */
export function setServiceSecret(options: ListOptions, service: string, scope: SecretScope, sandbox: string | null, value: string): Promise<void> {
  if (!/^[a-z][a-z0-9-]*$/i.test(service)) throw new Error("Unsupported service name")
  const args = ["secret", "set", service]
  return writeSecret(options, args, scope, sandbox, value)
}

/** Creates or updates a custom (non-predefined) secret such as "zeldoc". */
export function setCustomSecret(options: ListOptions, name: string, scope: SecretScope, sandbox: string | null, value: string): Promise<void> {
  if (!/^[a-z][a-z0-9-]*$/i.test(name)) throw new Error("Unsupported secret name")
  const args = ["secret", "set-custom", "--name", name]
  return writeSecret(options, args, scope, sandbox, value)
}

function writeSecret(options: ListOptions, args: string[], scope: SecretScope, sandbox: string | null, value: string): Promise<void> {
  const withScope = scope === "sandbox"
    ? [...args, "--sandbox", requireSandboxName(sandbox)]
    : args
  return new Promise((resolve, reject) => {
    const child = execFile(options.executable, withScope, {
      encoding: "utf8",
      timeout: ACTION_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      signal: options.signal,
    }, (error, _stdout, stderr) => {
      if (options.signal.aborted) {
        reject(options.signal.reason ?? new Error("Secret write cancelled"))
        return
      }
      if (error) {
        reject(commandError(error, stderr, {
          timeout: ACTION_TIMEOUT_MS,
          failureMessage: "Could not store the secret. Check `sbx secret ls` in a terminal, then try again.",
        }))
        return
      }
      resolve()
    })
    // The value is passed through stdin; the CLI prompts without a TTY only if stdin is open.
    child.stdin?.end(`${value}\n`)
  })
}

function requireSandboxName(sandbox: string | null): string {
  if (!sandbox || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(sandbox)) {
    throw new Error("Choose a sandbox for this secret, or scope it globally.")
  }
  return sandbox
}

export interface LoginSession {
  /** Browser URL to open for device confirmation; null when the CLI output was not understood. */
  readonly url: string | null
  /** One-time device code, e.g. "KSKV-HZRV"; null when unavailable. */
  readonly code: string | null
}

/** Extracts the device confirmation URL and code from `sbx login` output as it appears. */
export function parseLoginOutput(output: string): LoginSession {
  const url = /https:\/\/login\.docker\.com\/\S*/.exec(output)?.[0] ?? null
  const code = /confirmation code is:?\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/.exec(output)?.[1] ?? null
  return { url, code }
}

/**
 * Starts `sbx login` and resolves with the device confirmation URL once the CLI prints it.
 * The promise stays pending while the CLI waits for the browser confirmation; the caller
 * completes or cancels it through the returned controls. Never reads stdin, so the CLI
 * cannot block on a prompt.
 */
export function startLogin({ executable, signal }: ListOptions, options = {
  timeout: LOGIN_TIMEOUT_MS,
}) {
  let started = (url: LoginSession) => {}
  let closed: (outcome: "confirmed" | "cancelled" | "failed") => void = () => {}
  const session = new Promise<LoginSession>((resolve) => { started = resolve })
  const done = new Promise<"confirmed" | "cancelled" | "failed">((resolve) => { closed = resolve })
  const child = execFile(executable, ["login"], {
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    signal,
  }, (error) => {
    closed(error ? "failed" : "confirmed")
  })
  // The CLI never reads stdin here, but close it so it cannot block on a prompt either.
  child.stdin?.end()
  let buffer = ""
  const forward = (chunk: unknown) => {
    buffer += String(chunk)
    if (buffer.includes("Waiting for authentication")) {
      const parsed = parseLoginOutput(buffer)
      if (parsed.url || parsed.code) {
        child.stdout?.off("data", forwardOut)
        child.stderr?.off("data", forwardErr)
        started(parsed)
      }
    }
  }
  const forwardOut = (chunk: unknown) => forward(chunk)
  const forwardErr = (chunk: unknown) => forward(chunk)
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", forwardOut)
  child.stderr?.on("data", forwardErr)
  return { session, done }
}

export async function changeSandbox(options: ListOptions, sandbox: Sandbox, action: SandboxAction): Promise<void> {
  const args = action === "stop"
    ? ["stop", "--", sandbox.name]
    : ["run", "--detach", "--name", sandbox.name]
  await executeSbx(options, args, {
    timeout: ACTION_TIMEOUT_MS,
    failureMessage: `Could not ${action} the sandbox. Check sbx in a terminal, then refresh to check its status before retrying.`,
  })
}

function executeSbx(
  { executable, signal }: ListOptions,
  args: string[],
  options?: { timeout: number; failureMessage: string; acceptFailureOutput?: (output: string) => boolean },
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
      if (error && !(typeof error.code === "number" && !error.killed && options?.acceptFailureOutput?.(stdout))) {
        reject(commandError(error, stderr, options))
        return
      }
      resolve(stdout)
    })
    // Lifecycle actions must never wait for interactive input.
    child.stdin?.end()
  })
}
