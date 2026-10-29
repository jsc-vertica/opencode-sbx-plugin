# OpenCode Docker Sandboxes

A **Docker Sandboxes** side panel for OpenCode Desktop. Lists local sandboxes, their running/stopped status, agent, and workspaces using `sbx ls --format json`, with buttons to start and stop existing sandboxes.

## Requirements

- **OpenCode Desktop 2.2.2** (the GUI API is experimental; this is the SDK version targeted and type-checked by this project).
- Docker Sandboxes with `sbx` available to the Desktop process. CLI output verified against **sbx 0.50.1** on Linux.
- **Node.js 22.12+** (or 24 LTS) and npm to build. Node is not needed separately to run the bundled plugin in Desktop.

The OpenCode CLI and Desktop are separate installations: upgrading the CLI alone does not upgrade Desktop's GUI plugin host.

## Build

```bash
npm ci
npm run check
```

The build produces a single `dist/gui-experimental.cjs` bundle. The package intentionally has **no server or TUI entry**. `@opencode/plugin/gui`, Solid, and Effect are supplied by Desktop at runtime; they are not bundled.

If your system Node is older, you can run commands with a temporary Node 24 runtime without changing the global installation:

```bash
npm exec --yes --package=node@24 -- npm ci
npm exec --yes --package=node@24 -- npm run check
```

## Load in Desktop

Build first, then add this directory to the `plugins` array in your **global** `~/.config/opencode/opencode.jsonc` (or `$XDG_CONFIG_HOME/opencode/opencode.jsonc`). Preserve your existing configuration and plugin entries:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "/home/jsc/projects/opencode-sbx-plugin"
  ]
}
```

In Desktop, open a session and select **+ → Docker Sandboxes** in the side panel, or run **Open Docker Sandboxes** from the command palette. The panel can also be dragged to a bottom pane using Desktop's normal tab controls.

On a draft or another view without a mounted session, the same action opens the inventory in a dialog instead: Desktop's session panel API needs a mounted session. Narrow windows also offer Docker Sandboxes in the view switcher's **More** menu.

OpenCode watches configuration changes. While developing, run:

```bash
npm run dev
```

Rebuilt local bundles reload automatically. **Settings → Extensions → Plugins** shows whether the GUI loaded and lets you disable it. This project does not modify your global configuration automatically.

The IPC contract ID in `src/contract.ts` is versioned. When changing bridge methods or the state schema, bump its version: Desktop 2.2.2 retains IPC clients/codecs by ID across GUI rebuilds. Reusing an old ID can leave a newly loaded panel connected through an outdated schema.

The footer shows the sbx CLI and daemon versions, read once via `sbx version --format json` and reused across refreshes. It also shows whether sbx is signed in, read once from the Authentication check of `sbx diagnose --format json`. Only a passing "authenticated" report counts as signed in; a failed or missing check shows "authentication unknown" rather than "signed out".

### Custom sbx executable

Desktop may inherit a different `PATH` than your terminal. Set an absolute executable path if needed:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/jsc/projects/opencode-sbx-plugin",
      "options": { "sbxPath": "/usr/bin/sbx" }
    }
  ]
}
```

`sbxPath` is one executable path, not a shell command; arguments and shell syntax are not supported.

## Behavior

- Lists **local** sandboxes on the machine running Desktop, even for sessions connected to a remote OpenCode server. It does not pass `--cloud`.
- Keeps cards compact: agent and workspace details are hidden until you toggle **Info**. The expanded state is preserved across automatic refreshes while the panel stays mounted.
- Refreshes on opening/showing the panel, every five seconds while visible, and on **Refresh**. Polling pauses when the panel or app document is hidden.
- All Desktop windows share a main-process snapshot. Simultaneous refresh requests share one CLI invocation.
- Shows **Start** for stopped sandboxes and **Stop** for running ones. Start uses `sbx run --detach --name NAME` without opening an interactive agent session; Stop uses `sbx stop -- NAME` and retains the sandbox. **Stopping interrupts any active work in that sandbox.**
- Rechecks the sandbox ID and status against a fresh listing before an action. Duplicate clicks across windows share one operation; stale clicks never toggle in the opposite direction. Unknown/transitional statuses have no action button, and stale inventories disable controls until a successful refresh.
- Shows a busy button during each operation, reports failures on that sandbox's card, and refreshes the inventory afterward. There are no create or delete controls. As with running `sbx ls` yourself, listing may initialize its daemon.
- Uses asynchronous child processes without a shell, with a ten-second listing timeout, a sixty-second start/stop timeout, and bounded output buffers. Disabling/reloading the plugin cancels active commands. A timed-out lifecycle command may have partially completed; refresh to check status before retrying.
- Unknown statuses are displayed verbatim, not treated as stopped. Empty inventories and CLI failures are distinct states.
- After a failed refresh, the last successful inventory remains visible with a stale-data warning. Raw CLI stderr and sandbox paths are not written to logs.

After updating sbx, its daemon may require a restart. The panel only explains this; it never restarts it automatically. Running `sbx daemon restart` in your terminal **stops running sandboxes**.

## Validation

```bash
npm run typecheck
npm test
npm run build
```

Tests cover JSON parsing, status classification, error reporting, process execution/cancellation, shared refreshes, retaining the last successful inventory after errors, and start/stop validation, locking, and CLI arguments. Lifecycle tests use fake commands and do not start or stop real sandboxes. For a live smoke test, load the plugin, open/close it, hide/show the app, switch sessions, and verify refresh behavior. Test in both light and dark themes; use a disposable sandbox to verify start/stop controls.
