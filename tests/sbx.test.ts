import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { statusTone } from "../src/model"
import { ACTION_TIMEOUT_MS, changeSandbox, commandError, listSandboxes, parseSandboxes, SbxError } from "../src/sbx"

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
