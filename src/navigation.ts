import type { Context } from "@opencode/plugin/gui"

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
