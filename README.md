# OpenCode Docker Sandboxes

A **Docker Sandboxes** settings page for OpenCode Desktop. Lists local sandboxes, their running/stopped status, agent, and workspaces using `sbx ls --format json`, with buttons to start, stop, and repair existing sandboxes.

## Requirements

- **OpenCode Desktop 2.2.2** (the GUI API is experimental; this is the SDK version targeted and type-checked by this project).
- Docker Sandboxes with `sbx` available to the Desktop process. CLI output verified against **sbx 0.50.1** on Linux.
- **Node.js 22.12+** (or 24 LTS) and npm to build. Node is not needed separately to run the bundled plugin in Desktop.

The OpenCode CLI and Desktop are separate installations: upgrading the CLI alone does not upgrade Desktop's GUI plugin host.

## Install from GitHub (no build required)

Install the prebuilt **release** branch using OpenCode CLI 2.2.2:

```bash
opencode plugin add github:jsc-vertica/opencode-sbx-plugin#release
```

This adds the plugin to your global OpenCode configuration. Open Desktop, then select **Settings → Docker Sandboxes** or run **Open Docker Sandboxes** from the command palette. Sign-in and first-time network policy setup are offered on this page when needed. Docker Sandboxes must already be installed separately, with `sbx` available to Desktop.

The `release` branch contains the prebuilt GUI, README, and a minimal package manifest with no build scripts or dependencies. You do not need to clone the source or install Node/Vite/Electron to build it. The `master` branch is for development; do not use it as the install target because OpenCode 2.2.2's Git dependency preparation fails on its build hooks.

Update the installed release with:

```bash
opencode plugin update github:jsc-vertica/opencode-sbx-plugin#release
```

If you previously configured a local checkout, remove that local path entry before switching to the GitHub package so the same plugin is not configured twice. No npm publication is required.

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

In Desktop, select **Settings → Docker Sandboxes**, or run **Open Docker Sandboxes** from the command palette. The command opens the same settings page.

This is a machine-wide settings page and does not require an open session. It replaces the former side-panel tab, **+** launcher, draft-session dialog, and narrow-screen view entry.

OpenCode watches configuration changes. While developing, run:

```bash
npm run dev
```

Rebuilt local bundles reload automatically. **Settings → Extensions → Plugins** shows whether the GUI loaded and lets you disable it. This project does not modify your global configuration automatically.

The IPC contract ID in `src/contract.ts` is versioned. When changing bridge methods or the state schema, bump its version: Desktop 2.2.2 retains IPC clients/codecs by ID across GUI rebuilds. Reusing an old ID can leave a newly loaded panel connected through an outdated schema.

The settings page ID is the plugin ID (`opencode-sbx-plugin`). The command uses that exact ID with `ctx.layout.settings`; the page and its search metadata are registered without mounting the inventory or starting CLI polling.

The footer shows the sbx CLI and daemon versions, read once via `sbx version --format json` and reused across refreshes. It also shows whether sbx is signed in, read from the Authentication check of `sbx diagnose --format json`. Diagnostics are reused during normal polling once the network policy is initialized, and rechecked after login, lifecycle actions, and policy setup. Missing/unknown policy setup is rechecked while polling so setup completed in a terminal is detected too. Only a passing "authenticated" report counts as signed in; a failed or missing check shows "authentication unknown" rather than "signed out".

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
- **Repair**, immediately after **Info**, re-runs `sbx run --detach --name NAME` to attempt recovery when the sandbox's MCP gateway is missing. It runs even if the sandbox is already running and also starts stopped sandboxes. It shows **Repairing…**, prevents overlapping repair/start/stop operations on the same sandbox across windows, reports failures on the card, and refreshes afterward. Unknown/transitional states, stale inventory, and missing/pending network policy setup disable Repair. It does not stop or recreate the sandbox.
- Refreshes on opening the settings page, every five seconds while it is active, and on **Refresh**. Leaving the page unmounts its content and stops polling; polling also pauses while the app document is hidden.
- All Desktop windows share a main-process snapshot. Simultaneous refresh requests share one CLI invocation.
- Shows **Start** for stopped sandboxes and **Stop** for running ones. Start uses `sbx run --detach --name NAME` without opening an interactive agent session; Stop uses `sbx stop -- NAME` and retains the sandbox. **Stopping interrupts any active work in that sandbox.**
- Rechecks the sandbox ID and status against a fresh listing before an action. Duplicate clicks across windows share one operation; stale clicks never toggle in the opposite direction. Unknown/transitional statuses have no action button, and stale inventories disable controls until a successful refresh.
- Shows a busy button during each operation, reports failures on that sandbox's card, and refreshes the inventory afterward. There are no create or delete controls. As with running `sbx ls` yourself, listing may initialize its daemon.
- When sbx is signed out (`sbx ls` fails with "not signed in"), the error panel offers a **Sign in to Docker** button. It runs `sbx login` in the main process; the CLI opens the device-confirmation URL in your default browser itself, and the panel shows the one-time device code. The button shows "Waiting for sign-in…" while the CLI waits for confirmation, and the offer disappears once a listing succeeds again. One login flow runs at a time; it ends after 10 minutes, on plugin shutdown, or when the CLI exits. Signing in requires interacting with docker.com in your browser; the panel never collects credentials.
- **Service secrets** can be stored from the panel. Pick a predefined name (including the custom `zeldoc` entry or any of the CLI's service names), or choose **Custom…** and type a name. Choose the **global** scope (all sandboxes) or scope the secret to a single sandbox by name. The value is sent to the Desktop main process over IPC and piped to `sbx secret set` / `sbx secret set-custom` through stdin; it is never placed in argv, logged, or displayed again. The stored secret list (names and scopes only, never values) refreshes with the inventory and reflects secrets created in a terminal. One create runs at a time across windows; a refresh follows every create.
- After sign-in, an uninitialized **Global network policy** diagnostic shows a one-time policy picker. Choose **Balanced**, **Allow all**, or **Deny all (Locked Down)**, then click **Apply network policy** to run `sbx policy init <preset>`. Nothing is preselected or applied automatically. The choice applies to all local sandboxes, subject to organization governance. The panel rechecks setup before applying, never resets an existing policy, shares busy/error state across windows, and refreshes afterward. **Start** is disabled while setup is required/pending; applying a policy does not automatically start any sandbox. Missing or unsupported diagnostics are not interpreted as consent to change policy. See Docker's [local policy guide](https://docs.docker.com/ai/sandboxes/governance/access-controls/local/) for preset details.
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

Tests cover JSON parsing, status classification, error reporting, process execution/cancellation, shared refreshes, retaining the last successful inventory after errors, start/stop validation, and explicit policy initialization, including nonzero diagnostic exits, post-login rechecks, existing-policy protection, locking, and CLI arguments. Lifecycle and policy tests use fake commands and do not start/stop real sandboxes or change the machine's network policy. For a live smoke test, load the plugin, open/close it, hide/show the app, switch sessions, and verify refresh behavior. Test in both light and dark themes; use a disposable sandbox to verify start/stop controls. Use an isolated test installation for the uninitialized-policy flow; do not reset a real policy just to test the picker.

## Maintaining the prebuilt GitHub release

`master` keeps the source and build tools; `release` keeps only the generated installable files. On a maintainer checkout, clone the existing release branch into the ignored `.release/` directory once:

```bash
git clone --branch release --single-branch https://github.com/jsc-vertica/opencode-sbx-plugin.git .release
```

For each release, use Node 24, synchronize that checkout, then validate/build and regenerate the distribution:

```bash
git -C .release pull --ff-only
npm run release:prepare
git -C .release add package.json README.md dist/gui-experimental.cjs
git -C .release commit -m "release: update prebuilt Docker Sandboxes plugin"
git -C .release push origin release
```

`release:prepare` runs typechecking, tests, and the GUI build before copying the artifact. It preserves the package name/GUI export and removes all install-time scripts and dependencies from the distribution manifest. It also copies `LICENSE` if one is added; include that file in the release commit too. Test the GitHub target in a disposable OpenCode profile before recommending a new release.
