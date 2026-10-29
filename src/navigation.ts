import type { Context, SessionPanelMenuItem } from "@opencode/plugin/gui"

/** Keep the launcher row mounted when focus/layout changes during a pointer press. */
export function createSandboxLauncher(
  ctx: Pick<Context, "id" | "sessions" | "layout">,
  key: string,
  run: () => void,
): SessionPanelMenuItem {
  return {
    id: "open",
    menu: "session.panel",
    title: "Docker Sandboxes",
    description: "Local sandbox status",
    icon: "cube",
    keybind: `${ctx.id}.open`,
    // A reactive factory returning a new object replaces Desktop's keyed launcher
    // button on pointerdown, before mouseup can deliver its click. Use a stable
    // item with a reactive getter instead.
    get opened() {
      const session = ctx.sessions.current()
      return !!session && ctx.layout.state(key, session) !== "closed"
    },
    run,
  }
}

/** Desktop offers launchers on drafts too, where sessions.current() is undefined. */
export function openSandboxes(
  ctx: Pick<Context, "sessions" | "layout">,
  key: string,
  withoutSession: () => void,
): void {
  const session = ctx.sessions.current()
  if (!session) {
    withoutSession()
    return
  }

  // The default open also selects the panel's mobile view on a narrow window.
  // { tab: "select" } intentionally keeps that view unchanged, so is wrong for a launcher.
  ctx.layout.open(key, session)
}
