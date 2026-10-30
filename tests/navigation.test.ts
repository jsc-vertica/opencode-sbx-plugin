import assert from "node:assert/strict"
import { test } from "node:test"
import { Command, MenuItem, Panel, SettingsPage, type Context } from "@opencode/plugin/gui"
import { registerSandboxSettings } from "../src/navigation"

function context(platform: "desktop" | "web" = "desktop", id = "opencode-sbx-plugin") {
  const contributions: { registry: { readonly id: string }; item: unknown }[] = []
  const opened: string[] = []
  // Deliberately no sessions, dialogs, side-panel writes, or readiness checks.
  const ctx = {
    id,
    app: { platform },
    add: (registry: { readonly id: string }, item: unknown) => {
      contributions.push({ registry, item })
      return () => {}
    },
    layout: { settings: (page: string) => { opened.push(page) } },
  } as unknown as Pick<Context, "id" | "app" | "add" | "layout">
  const page = () => contributions.find((item) => item.registry.id === SettingsPage.id)?.item as SettingsPage
  const command = () => {
    const factory = contributions.find((item) => item.registry.id === Command.id)?.item as () => Command
    return factory()
  }
  return { ctx, contributions, opened, page, command }
}

test("registers a top-level settings page instead of a side panel or launcher", () => {
  const env = context()
  registerSandboxSettings(env.ctx, () => null)
  assert.deepEqual(env.contributions.map((item) => item.registry.id), [SettingsPage.id, Command.id])
  assert.equal(env.contributions.some((item) => item.registry.id === Panel.id || item.registry.id === MenuItem.id), false)
  assert.equal(env.page().id, "opencode-sbx-plugin")
  assert.equal(env.page().title, "Docker Sandboxes")
  assert.equal(env.page().icon, "cube")
  assert.equal(env.page().page, undefined, "must be its own page, not rows in General")
})

test("registration does not mount the inventory or start background polling", () => {
  const env = context()
  let renders = 0
  registerSandboxSettings(env.ctx, () => { renders++; return null })
  assert.equal(renders, 0)
  assert.deepEqual(env.opened, [])
  env.page().render({})
  assert.equal(renders, 1)
})

test("the existing open command navigates to settings without a mounted session", () => {
  const env = context()
  registerSandboxSettings(env.ctx, () => null)
  const command = env.command()
  assert.equal(command.id, "open")
  assert.equal(command.title, "Open Docker Sandboxes")
  assert.equal(command.enabled, true)
  command.run()
  command.run()
  assert.deepEqual(env.opened, ["opencode-sbx-plugin", "opencode-sbx-plugin"])
})

test("settings navigation uses the exact registered plugin page ID", () => {
  const env = context("desktop", "different-plugin-id")
  registerSandboxSettings(env.ctx, () => null)
  env.command().run()
  assert.deepEqual(env.opened, [env.page().id])
})

test("the page is discoverable in settings search without mounting its content", () => {
  const env = context()
  registerSandboxSettings(env.ctx, () => assert.fail("Search metadata must not render the inventory"))
  const entry = env.page().entries?.find((item) => item.id === env.page().id)
  assert.ok(entry)
  for (const word of ["sbx", "docker", "repair", "mcp", "login", "policy"]) assert.ok(entry.keywords?.includes(word))
})

test("the Desktop-specific open command stays disabled in web clients", () => {
  const env = context("web")
  registerSandboxSettings(env.ctx, () => null)
  assert.equal(env.command().enabled, false)
})
