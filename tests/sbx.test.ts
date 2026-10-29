import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { statusTone } from "../src/model"
import { ACTION_TIMEOUT_MS, changeSandbox, commandError, initializeNetworkPolicy, listSandboxes, parseDiagnostics, parseLoginOutput, parseSandboxes, parseVersions, readDiagnostics, readVersions, SbxError, startLogin } from "../src/sbx"
import type { NetworkPolicyPreset } from "../src/model"

const sample = {
  name: "website",
  id: "934f3387-614b-472f-b4c2-c32a15b6e73d",
  agent: "shell",
  status: "stopped",
  last_used_at: "2026-10-29T20:28:23.266952805Z",
  workspaces: ["/home/user/website", "/home/user/website/sbxenv.yaml:ro"],
  memory: "8g",
  memory_mib: 8192,
}

test("parses sbx 0.50.1 JSON and ignores fields not needed by the panel", () => {
  assert.deepEqual(parseSandboxes(JSON.stringify([sample])), [{
    id: sample.id, name: "website", status: "stopped", agent: "shell", workspaces: sample.workspaces,
  }])
})

test("accepts an empty inventory", () => {
  assert.deepEqual(parseSandboxes("[]\n"), [])
})

test("preserves running and unexpected statuses", () => {
  for (const status of ["running", "creating", "failed", "a-new-status"]) {
    const [sandbox] = parseSandboxes(JSON.stringify([{ ...sample, status }]))
    assert.equal(sandbox?.status, status)
  }
  assert.equal(statusTone("running"), "running")
  assert.equal(statusTone("RUNNING"), "running")
  assert.equal(statusTone("stopped"), "stopped")
  assert.equal(statusTone("failed"), "other")
  assert.equal(statusTone(""), "other")
})

test("accepts absent optional metadata", () => {
  assert.deepEqual(parseSandboxes('[{"id":"one","name":"one","status":"running"}]'), [{
    id: "one", name: "one", status: "running", agent: null, workspaces: [],
  }])
})

test("sorts the inventory by name without changing workspace strings", () => {
  const parsed = parseSandboxes(JSON.stringify([
    { ...sample, name: "zulu", id: "z" },
    { ...sample, name: "alpha", id: "a" },
  ]))
  assert.deepEqual(parsed.map((item) => item.name), ["alpha", "zulu"])
  assert.deepEqual(parsed[0]?.workspaces, sample.workspaces)
})

test("rejects malformed or unexpected output instead of pretending there are no sandboxes", () => {
  for (const input of [
    "", "warning: restart required\n[]", "{}", "null", "[null]", "[1]",
    JSON.stringify([{ ...sample, id: "" }]),
    JSON.stringify([{ ...sample, name: " " }]),
    JSON.stringify([{ ...sample, status: null }]),
    JSON.stringify([{ ...sample, agent: 123 }]),
    JSON.stringify([{ ...sample, workspaces: "/wrong/shape" }]),
    JSON.stringify([{ ...sample, workspaces: [123] }]),
    JSON.stringify([sample, sample]),
  ]) {
    assert.throws(() => parseSandboxes(input), (error: unknown) =>
      error instanceof SbxError && error.detail.code === "invalid-output")
  }
})

test("classifies a missing CLI and a command timeout", () => {
  assert.equal(commandError({ code: "ENOENT" }).detail.code, "missing-cli")
  assert.equal(commandError({ killed: true }).detail.code, "timeout")
})

test("distinguishes an output size limit from a timeout", () => {
  const error = commandError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true })
  assert.equal(error.detail.code, "invalid-output")
  assert.match(error.message, /size limit/)
})

test("explains daemon restart requirements without attempting a restart", () => {
  const error = commandError({ code: 1 },
    "warning: Docker Sandboxes has been updated and needs to restart; all running sandboxes will be stopped")
  assert.equal(error.detail.code, "daemon-restart-required")
  assert.match(error.message, /sbx daemon restart/)
  assert.match(error.message, /stops running sandboxes/)
})

test("does not leak raw CLI error output into the UI", () => {
  const error = commandError({ code: 1 }, "failure at /private/project with secret-token")
  assert.equal(error.detail.code, "command-failed")
  assert.doesNotMatch(error.message, /private|secret-token/)
})

async function fixture(t: TestContext, source: string): Promise<string> {
  const directory = await mkdtemp("/tmp/opencode/sbx-plugin-test-")
  t.after(() => rm(directory, { recursive: true, force: true }))
  // Spaces and a shell metacharacter exercise execFile's literal path handling.
  const executable = path.join(directory, "fake sbx;not-a-shell-command")
  await writeFile(executable, `#!${process.execPath}\n${source}\n`)
  await chmod(executable, 0o755)
  return executable
}

test("executes only the local JSON list command, safely handling executable paths with spaces", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fixture(t, `
    const expected = JSON.stringify(["ls", "--format", "json"])
    if (JSON.stringify(process.argv.slice(2)) !== expected) process.exit(2)
    process.stdout.write(${JSON.stringify(JSON.stringify([sample]))})
  `)
  const result = await listSandboxes({ executable, signal: new AbortController().signal })
  assert.equal(result[0]?.name, "website")
})

test("a missing executable is reported as an error, not an empty inventory", async () => {
  await assert.rejects(listSandboxes({
    executable: "/tmp/opencode/does-not-exist-sbx-plugin",
    signal: new AbortController().signal,
  }), (error: unknown) => error instanceof SbxError && error.detail.code === "missing-cli")
})

test("rejects command failures even if stdout resembles valid JSON", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fixture(t, 'process.stdout.write("[]"); process.exitCode = 1')
  await assert.rejects(listSandboxes({ executable, signal: new AbortController().signal }),
    (error: unknown) => error instanceof SbxError && error.detail.code === "command-failed")
})

test("cancels a running CLI process when the plugin stops", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fixture(t, "setInterval(() => {}, 1000)")
  const controller = new AbortController()
  const result = listSandboxes({ executable, signal: controller.signal })
  const reason = new Error("Plugin stopped")
  const timer = setTimeout(() => controller.abort(reason), 100)
  t.after(() => clearTimeout(timer))
  await assert.rejects(result, (error: unknown) => error === reason)
})

test("starts by name in detached mode without opening an agent session", {
  skip: process.platform === "win32",
}, async (t) => {
  const name = "sandbox with spaces; $(not-a-shell-command)"
  const expected = ["run", "--detach", "--name", name]
  const executable = await fixture(t, `
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(expected))}) process.exit(2)
    process.stdout.write("sandbox-id\\n")
  `)
  await changeSandbox({ executable, signal: new AbortController().signal }, { ...sample, name }, "start")
})

test("repair runs exactly sbx run --detach --name with the sandbox name as a literal argument", {
  skip: process.platform === "win32",
}, async (t) => {
  const name = "sandbox with spaces; $(not-a-shell-command)"
  const expected = ["run", "--detach", "--name", name]
  const executable = await fixture(t, `
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(expected))}) process.exit(2)
    process.stdin.on("end", () => process.exit(0))
    process.stdin.resume()
  `)
  await changeSandbox({ executable, signal: new AbortController().signal }, { ...sample, name, status: "running" }, "repair")
})

test("repair command failures describe repair rather than start or stop", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fixture(t, 'process.stderr.write("private details"); process.exitCode = 1')
  await assert.rejects(changeSandbox({ executable, signal: new AbortController().signal }, sample, "repair"),
    (error: unknown) => error instanceof SbxError && /Could not repair/.test(error.message) && !/private/.test(error.message))
})

test("stops exactly one sandbox and separates a flag-like name from options", {
  skip: process.platform === "win32",
}, async (t) => {
  const name = "--all; $(not-a-shell-command)"
  const expected = ["stop", "--", name]
  const executable = await fixture(t, `
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(expected))}) process.exit(2)
  `)
  await changeSandbox({ executable, signal: new AbortController().signal }, { ...sample, name }, "stop")
})

test("lifecycle failures describe the attempted operation, not a listing failure", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fixture(t, 'process.stderr.write("private CLI details"); process.exitCode = 1')
  await assert.rejects(changeSandbox({ executable, signal: new AbortController().signal }, sample, "stop"),
    (error: unknown) => error instanceof SbxError && /Could not stop/.test(error.message)
      && !error.message.includes("private"))
})

test("lifecycle timeouts use the longer command deadline and warn about partial completion", () => {
  const error = commandError({ killed: true }, "", { timeout: ACTION_TIMEOUT_MS, failureMessage: "Failed" })
  assert.match(error.message, /60 seconds/)
  assert.match(error.message, /partially completed/)
})

test("parses client and daemon versions from sbx version --format json", () => {
  const output = `
    WARN: docker hub refresh lock held by another process: context deadline exceeded
    {
      "client": { "version": "v0.50.1", "revision": "ddb0268d7124b9cf98955d0b08ffd71a0dfcebe4" },
      "server": { "state": "running", "version": "v0.50.1", "revision": "ddb0268d7124b9cf98955d0b08ffd71a0dfcebe4", "api_version": "0.44.0" }
    }
  `
  assert.deepEqual(parseVersions(output), { client: "0.50.1", server: "0.50.1" })
})

test("falls back to a plain version string when the JSON shape is unknown", () => {
  assert.deepEqual(parseVersions("sbx version v0.48.0 5caf923"), { client: "0.48.0", server: null })
  assert.deepEqual(parseVersions("nothing recognizable here"), { client: null, server: null })
})

test("reads the version in detached mode without hanging on the daemon prompt", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fixture(t, `
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(["version", "--format", "json"]))}) process.exit(2)
    process.stdout.write(${JSON.stringify(JSON.stringify({
      client: { version: "v0.50.1", revision: "a".repeat(40) },
      server: { state: "running", version: "v0.50.1", revision: "a".repeat(40), api_version: "0.44.0" },
    }))})
  `)
  const versions = await readVersions({ executable, signal: new AbortController().signal })
  assert.deepEqual(versions, { client: "0.50.1", server: "0.50.1" })
})

const authenticatedReport = JSON.stringify({
  version: "1.0",
  checks: [
    { name: "Daemon", status: "pass", message: "healthy", detail: "version v0.50.1", hint: "" },
    { name: "Authentication", status: "pass", message: "authenticated", detail: "", hint: "" },
  ],
  summary: { pass: 2, warn: 0, fail: 0, skip: 0 },
})

test("reads the signed-in state from the diagnose report's Authentication check", () => {
  assert.equal(parseDiagnostics(authenticatedReport).auth, "authenticated")
  assert.equal(parseDiagnostics(authenticatedReport.replace("authenticated", "not authenticated")).auth, "unauthenticated")
  assert.equal(parseDiagnostics(authenticatedReport.replace("authenticated", "signed out")).auth, "unauthenticated")
})

test("a failing, skipped, or missing Authentication check is unknown, never signed out", () => {
  for (const status of ["fail", "warn", "skip"]) {
    const report = JSON.stringify({ checks: [{ name: "Authentication", status, message: "could not check", detail: "", hint: "" }] })
    assert.equal(parseDiagnostics(report).auth, "unknown")
  }
  assert.equal(parseDiagnostics(JSON.stringify({ checks: [{ name: "Daemon", status: "pass", message: "healthy" }] })).auth, "unknown")
  assert.equal(parseDiagnostics(JSON.stringify({ checks: [] })).auth, "unknown")
  assert.equal(parseDiagnostics("not json at all").auth, "unknown")
  assert.equal(parseDiagnostics(JSON.stringify({ checks: "wrong shape" })).auth, "unknown")
})

test("reads diagnostics in detached mode without hanging on the daemon prompt", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fixture(t, `
    if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(["diagnose", "--format", "json"]))}) process.exit(2)
    process.stdout.write(${JSON.stringify(authenticatedReport)})
  `)
  const result = await readDiagnostics({ executable, signal: new AbortController().signal })
  assert.equal(result.auth, "authenticated")
})

test("a signed-out listing is reported as not-signed-in, not a generic failure", () => {
  const error = commandError({ code: 1 }, "error: not signed in to Docker\n  try: sbx login")
  assert.equal(error.detail.code, "not-signed-in")
  assert.match(error.message, /Sign in/)
})

test("extracts the device confirmation URL and code from login output", () => {
  const output = `
    By logging in, you agree to our Subscription Service Agreement.

    Your one-time device confirmation code is: KSKV-HZRV
    Complete sign-in in your browser, then return to this terminal.
    Open this URL to sign in: https://login.docker.com/activate?user_code=KSKV-HZRV

    Waiting for authentication...
  `
  assert.deepEqual(parseLoginOutput(output), {
    url: "https://login.docker.com/activate?user_code=KSKV-HZRV",
    code: "KSKV-HZRV",
  })
  assert.deepEqual(parseLoginOutput("no device code in this output"), { url: null, code: null })
})

test("a started login surfaces the device code and resolves when the CLI exits", {
  skip: process.platform === "win32",
}, async (t) => {
  const controller = new AbortController()
  const executable = await fixture(t, `
    console.log("Your one-time device confirmation code is: TEST-CODE")
    console.log("Open this URL to sign in: https://login.docker.com/activate?user_code=TEST-CODE")
    console.log("Waiting for authentication...")
    let timer
    process.on("message", () => {
      clearTimeout(timer)
      process.exit(0)
    })
    timer = setTimeout(() => process.exit(1), 30000)
  `)
  const login = startLogin({ executable, signal: controller.signal })
  const session = await Promise.race([
    login.session,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ])
  assert.notEqual(session, "timeout")
  if (session !== "timeout") {
    assert.equal(session.code, "TEST-CODE")
    assert.equal(session.url, "https://login.docker.com/activate?user_code=TEST-CODE")
  }
  const outcome = await Promise.race([
    (async () => {
      // The fixture exits when the plugin stops: cancellation reports the CLI's failure, not a hang.
      controller.abort()
      return await login.done
    })(),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ])
  assert.notEqual(outcome, "timeout")
  assert.equal(outcome, "failed")
})

test("diagnostics distinguish explicit missing policy from initialized or unavailable policy", () => {
  const report = (status: string, message: string) => JSON.stringify({
    checks: [{ name: "Global network policy", status, message }],
  })
  assert.equal(parseDiagnostics(report("pass", "initialized")).networkPolicy, "initialized")
  assert.equal(parseDiagnostics(report("warn", "not initialized")).networkPolicy, "required")
  assert.equal(parseDiagnostics(report("fail", "global network policy has not been initialized")).networkPolicy, "required")
  for (const [status, message] of [["skip", "Skipped: Daemon failed"], ["fail", "not reachable"], ["pass", "new unknown format"], ["skip", "not initialized"]] as const) {
    assert.equal(parseDiagnostics(report(status, message)).networkPolicy, "unknown")
  }
  assert.equal(parseDiagnostics(authenticatedReport).networkPolicy, "unknown")
  assert.equal(parseDiagnostics("not json").networkPolicy, "unknown")
})

test("diagnose preserves its JSON report on a nonzero exit caused by missing setup", {
  skip: process.platform === "win32",
}, async (t) => {
  const report = JSON.stringify({ checks: [
    { name: "Authentication", status: "pass", message: "authenticated" },
    { name: "Global network policy", status: "fail", message: "not initialized" },
  ] })
  const executable = await fixture(t, `process.stdout.write(${JSON.stringify(report)}); process.exitCode = 1`)
  assert.deepEqual(await readDiagnostics({ executable, signal: new AbortController().signal }), {
    auth: "authenticated", networkPolicy: "required",
  })
})

test("diagnose does not accept a failed command with malformed or unrelated JSON", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fixture(t, 'process.stdout.write("{}"); process.exitCode = 1')
  await assert.rejects(readDiagnostics({ executable, signal: new AbortController().signal }),
    (error: unknown) => error instanceof SbxError && error.detail.code === "command-failed")
})

test("classifies missing policy without confusing it with existing policy or connectivity failures", () => {
  for (const message of [
    "global network policy has not been initialized; run: sbx policy init <allow-all|balanced|deny-all>",
    "the global network policy is not initialized",
    "policy.not_initialized", "policy_not_initialized",
  ]) assert.equal(commandError({ code: 1 }, message).detail.code, "network-policy-required")
  for (const message of ["global network policy is already initialized; reset it first", "check network policy: daemon unavailable"]) {
    assert.equal(commandError({ code: 1 }, message).detail.code, "command-failed")
  }
})

test("policy setup passes only the selected preset and never runs reset or a shell", {
  skip: process.platform === "win32",
}, async (t) => {
  for (const preset of ["balanced", "allow-all", "deny-all"] as const) {
    const expected = ["policy", "init", preset]
    const executable = await fixture(t, `
      if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(expected))}) process.exit(2)
      process.stdin.on("end", () => process.exit(0))
      process.stdin.resume()
    `)
    await initializeNetworkPolicy({ executable, signal: new AbortController().signal }, preset)
  }
})

test("policy setup rejects unsupported presets before executing the CLI", async () => {
  await assert.rejects(initializeNetworkPolicy({
    executable: "/tmp/opencode/does-not-exist-sbx-plugin", signal: new AbortController().signal,
  }, "balanced; other-command" as NetworkPolicyPreset), /Unsupported network policy preset/)
})

test("policy setup failures explain that existing policy is never reset", {
  skip: process.platform === "win32",
}, async (t) => {
  const executable = await fixture(t, 'process.stderr.write("private-path secret-token"); process.exitCode = 1')
  await assert.rejects(initializeNetworkPolicy({ executable, signal: new AbortController().signal }, "balanced"),
    (error: unknown) => error instanceof SbxError && /never reset/.test(error.message) && !/private|secret-token/.test(error.message))
})
