import { Command, SettingsPage, type Context } from "@opencode/plugin/gui"

/** A machine-wide settings page, independent of the current session or panel layout. */
export function registerSandboxSettings(
  ctx: Pick<Context, "id" | "app" | "add" | "layout">,
  render: SettingsPage["render"],
): void {
  // Settings page IDs are used verbatim by both the sidebar and layout.settings.
  const page = ctx.id
  ctx.add(SettingsPage, {
    id: page,
    title: "Docker Sandboxes",
    icon: "cube",
    entries: [{
      id: page,
      title: "Docker Sandboxes",
      description: "Manage local sandboxes, Docker sign-in, and network policy",
      keywords: "sbx docker sandbox containers status start stop repair mcp login network policy",
    }],
    render,
  })
  ctx.add(Command, (): Command => ({
    id: "open",
    title: "Open Docker Sandboxes",
    description: "Manage local sandboxes in Settings",
    keywords: "sbx docker sandbox containers status settings repair mcp",
    group: "Docker Sandboxes",
    enabled: ctx.app.platform === "desktop",
    run: () => ctx.layout.settings(page),
  }))
}
