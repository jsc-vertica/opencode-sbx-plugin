# Handoff: Docker Sandboxes launcher dead in OpenCode Desktop (recurrence)

Project: `/home/jsc/projects/opencode-sbx-plugin` (git repo, clean tree at commit `977de4e`)
Date: 2026-10-29, ~23:20 local. All times below are local (UTC+1).

## Symptom

The **Docker Sandboxes** launcher in Desktop's side-panel **+ menu is visible but clicking it does nothing**.
The panel does not open, no error appears, and **Settings → Extensions → Plugins shows no error** for the plugin.

This is the **second occurrence**. The first occurrence (≈22:07–22:15) was diagnosed and worked around;
details below. The current occurrence (≈22:16 onward) survived:

- `vite build` rebuilds of the bundle (bundle mtime 23:02, plugin shows in `opencode plugin list`).
- Toggle off/on in **Settings → Extensions → Plugins**.
- **Full Desktop app restart** at 23:14 (new log dir `20261029T221415`, PID 100611).

## Environment

- OpenCode Desktop **2.2.2** (`/opt/OpenCode/ai.opencode`), Electron app, packaged.
- OpenCode CLI 2.2.2 as Desktop's bundled background service (`/opt/OpenCode/resources/opencode-cli`),
  also serving `/api/info` on `127.0.0.1:49374`.
- User's CLI also upgraded to 2.2.2 via `opencode upgrade` earlier today.
- sbx **0.50.1** at `/usr/bin/sbx`; user is **signed out of Docker** right now (so `sbx ls` fails with
  `error: not signed in to Docker` and the daemon may be stopped — `sbx diagnose` shows
  Authentication `skip: "Skipped: Daemon failed"` and Daemon `fail: not reachable`).
- Plugin configured in global `~/.config/opencode/opencode.jsonc` → `plugins: ["opencode-zeldoc", "/home/jsc/projects/opencode-sbx-plugin"]`.
- Plugin package: no server part; only `"./gui-experimental": "./dist/gui-experimental.cjs"` export.
- Tests: `npm run check` green (61 tests) just before the report; run with
  `npm exec --yes --package=node@24 -- npm run check` (system node is 18).

## Key facts about Desktop's GUI plugin loading (verified by reading app.asar sources)

Desktop 2.2.2 (`/opt/OpenCode/resources/app.asar`, sourcemaps readable):

- `app/src/runtime/plugin/plugins.tsx` — the renderer window **evaluates the bundle code that Desktop's
  main process pushes** over the bridge (`pluginGuis` message: `{plugins, reserved}` with `id`, `revision`, `code`).
- `app/src/runtime/plugin/module.ts` — `pluginDefinition(id, code)` evaluates the code with a custom
  `require` that shares app modules (`effect`, `solid-js`, `@opencode/plugin/gui`, ...) and returns
  `{ ...definition, id, windowEntry }`. **A bundle that fails to evaluate becomes an entry that fails**
  (`windowEntry: () => Promise.reject(cause)`) — and apparently with **no visible error** in Extensions → Plugins
  (worth re-verifying).
- `app/src/runtime/plugin/installed.ts` — main pushes an `installed` list over the bridge;
  `bridge.manager.list()` / `initial()`.
- Desktop's main process reads plugin bundles **from its own background server with a private credential**;
  the server loads plugins listed in `opencode.jsonc`.
- IPC clients are **cached by contract ID** in the renderer (`app/src/runtime/plugin/ipc.ts`,
  `createIpcClients`): specs are registered on first subscribe; a same-ID contract with new methods/state
  is ignored. **This bit us once** — the fix was versioning the contract ID
  (`opencode-sbx-plugin.sandboxes.v5` now). Contract ID must be bumped whenever methods/state change.
- Renderer logs go to `~/.config/ai.opencode.desktop/logs/<session>/renderer.log`
  (electron-log; plugin `console.error` appears there as `[plugin] <id> <cause>`).

## History of the first occurrence (22:07–22:15) — SOLVED, then regressed

First time, the launcher click was a **silent no-op because `sessions.current()` was undefined** in the
launcher's `run` and the old code returned early. Fixed in `src/navigation.ts` (dialog fallback) — but
note: during live debugging the panel also failed to *render* until the **IPC contract ID was versioned**
(`...sandboxes` → `...sandboxes.v2`). Renderer log showed:

```
Error: Ipc "opencode-sbx-plugin.sandboxes" is unavailable: no method "inspect"
```

After bumping to v2 and rebuilding, a genuine (CDP `Input.dispatchMouseEvent`) click opened the panel and
it rendered `hth-website`. That session's verification was done by scripted clicks from the main process
(diagnostics code since **removed** from the bundle).

## Current occurrence — what was checked (23:14–23:20)

All in the fresh app session (`logs/20261029T221415`):

- `main.log` is **normal** up to 23:15:55 — app start, service ready, updater fine. **No `sbx` diagnostics**
  lines (expected — those were removed), and **no plugin errors**.
- `renderer.log` has only:
  ```
  [2026-10-29 23:15:55.646] [info]  [global-sdk] event stream disconnected [object Object]
  [2026-10-29 23:15:55.678] [error] ClientError: Transport: network error
  ```
  and no `[plugin] ...` lines at all. **No "loading plugin"/plugin failure entries were written to
  `~/.local/share/opencode/log/opencode.log` after the 23:14 restart** (log is healthy and being written;
  last `loading plugin` entries are 22:07). Suspicious: after restart the server should re-log
  `loading plugin` for each plugin; it did not appear in the greps performed (verify — grep coverage of
  the log was partial).
- Background service: `opencode service status` → `http://127.0.0.1:49374`; `/api/info` answers **401 without
  credentials** (expected); the service PID 61438 has been up 1h46m — **the service was NOT restarted with the
  app**; Desktop reconnected to the same long-lived service (`probed: false` at 23:15:55, one reconnect
  after a network error).
- `opencode plugin list` shows the plugin (`opencode-sbx-plugin`, local, path above).
- The current bundle builds and runs: `npm run check` green; `node dist/gui-experimental.cjs` fails only with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@opencode/plugin/gui` when run under **system node 18** — expected,
  since the app provides that module at runtime (do not treat as a bundle bug; test with node 24 if needed).
- Renderer Local Storage / Session Storage leveldb contain no `sbx` plugin disable flags;
  `opencode.settings` has only window/theme/ssh keys. **No evidence the user disabled the plugin's GUI**,
  but the renderer keeps plugin enable state in memory/leveldb — not fully ruled out.

## Leading hypotheses (unverified)

1. **Renderer never received/evaluated the latest bundle.** The main process pushes `pluginGuis` on a
   `revision` change. After the 23:14 restart the renderer had a transport error at 23:15:55; if the
   `pluginGuis` push or `bridge.manager.list()` reply was lost and never re-sent, the window may have
   **no plugin GUIs at all** — which matches "launcher present but dead" only if the launcher row the user
   clicks is a stale DOM from a previous session (unlikely after a full app restart) — OR the launcher
   the user clicks comes from the **command palette / + menu fed by an older evaluation**.
   → Next step: check whether ANY plugin GUI is active in the window (e.g. does the `zeldoc` plugin's GUI
   still work? do built-in plugin panels work?), and add temporary logging on the main-process bridge
   (`pluginGuis` push contents + revision) to see what the window receives.
2. **The bundle fails to evaluate in the renderer** and Desktop swallows the error silently (module.ts
   creates a rejecting `windowEntry`). A new failure mode since v4→v5 could be:
   - `electron` import in `src/main.ts` (`import { shell } from "electron"`): main-only module; in a
     **window** it should be an inert placeholder — verify the placeholder tolerates
     `shell.openExternal(...).catch()`. The docs say placeholders accept any property read/call, but
     `shell.openExternal()` returns a placeholder (not a promise) → `.catch` on it may **throw** inside
     `main()`... but `main` runs in the main process, not the window. The **window** bundle also evaluates
     the whole file — the import itself must be the placeholder. Verify by checking whether the renderer
     logs `[plugin] opencode-sbx-plugin <cause>` anywhere (grep renderer.log for `[plugin]`).
   - `startLogin` uses `execFile` + child stdout listeners at module scope? No — inside `main()` only.
     Module scope only defines functions. Should be safe.
   → Next step: open DevTools in the Desktop window (how: enable via app menu/shortcut if available, or
   run Desktop with `--remote-debugging-port=9222` and connect Chrome) and read the console for
   `[plugin]` errors; also test a minimal bundle (previous git tag/commit) to bisect.
3. **The long-lived background service (PID 61438) is stale**: it has served since 21:27 and may hold an
   old plugin list/credentials for pushing GUIs. `opencode service restart` (or killing PID 61438 and
   letting Desktop restart it) is a cheap, high-value next step. **The 23:14 app restart did not restart
   the service.**
4. **Signed-out sbx state**: unrelated to launcher deadness (the panel is supposed to show a sign-in
   offer), but note the plugin was developed/tested mostly while signed in; the not-signed-in path is new
   (commit `977de4e`). A crash during panel render would now be caught by the ErrorBoundary added in
   `src/window.tsx` (renders a fallback with "Try again") — if the user saw that fallback, they'd report
   an error, not a dead click. So render failure is unlikely to be the reported symptom.

## Concrete next steps (in order)

1. `opencode service restart`, then fully quit and reopen Desktop. Retry the launcher. (Cheapest fix for
   hypothesis 3.)
2. If still dead: enable remote debugging
   (`/opt/OpenCode/ai.opencode --remote-debugging-port=9222` — verify the correct flag passthrough) and
   inspect the window console for `[plugin]` errors and whether `pluginGuis` arrived.
3. Bisect the bundle: `git stash`/checkout the previous working commit (`affd7d4` or `3b9c8ec`), rebuild,
   reload. If an older commit works, the regression is in `991012c` or `977de4e` (auth label / login
   button). Prime suspects in `977de4e`:
   - `import { shell } from "electron"` in `src/main.ts` (new electron import in the shared bundle).
   - The `login` field added to the IPC state schema (contract bumped to v5 — required).
   - `startLogin`'s stdout forwarding in `src/sbx.ts`.
4. If the plugin GUI is entirely absent from the window: instrument main to log what it pushes
   (`pluginGuis` list + revisions) — temporarily add `ctx.log.write` lines in `src/main.ts` setup and in a
   bridge message handler if reachable from the plugin (may not be; then use DevTools instead).
5. Check `~/.local/share/opencode/log/opencode.log` after a service restart for fresh
   `loading plugin id=/home/jsc/projects/opencode-sbx-plugin` lines; their absence with a healthy server
   would mean the server isn't loading the plugin at all (config watch/state issue).

## Debugging techniques that worked before

- Read Desktop's renderer sources from the asar:
  `node -e` script reading `/opt/OpenCode/resources/app.asar`, file
  `out/renderer/assets/main-B1gC8E5t.js.map` → `sourcesContent` (indexes: host.tsx=307, ipc.ts=470,
  installed.ts=680, module.ts=681, panel-menu.ts=687, plugins.tsx=682, render.tsx=592, host-apis.tsx=713;
  route-*.js.map has panels.tsx=58 and side-region.tsx=70).
- Drive a genuine click from the main process via `webContents.debugger` + CDP
  (`Input.dispatchMouseEvent`) — this proved the launcher worked when a JS `.click()` didn't (previous
  session). Diagnostics were removed from the shipped bundle; re-add temporarily if needed
  (see git history for the removed `inspect.ts` pattern).
- Renderer console messages land in `~/.config/ai.opencode.desktop/logs/<session>/renderer.log`
  (electron-log). Plugin errors appear as `[plugin] <id> <stack>`.
- `sbx` fake-CLI test fixtures live in `tests/sbx.test.ts` (`fixture()` helper) — reuse for any new CLI
  parsing.

## Working conventions in this repo

- Build/check: `npm exec --yes --package=node@24 -- npm run check` (typecheck + tests + vite build).
- Contract changes require bumping the versioned IPC ID in `src/contract.ts` (now `...sandboxes.v5`)
  AND updating `tests/contract.test.ts` expectations.
- The user's global config was never modified by the agent; Desktop reloads the local plugin on rebuild.
- Don't run `sbx login` non-interactively for testing: it prints a device code and waits; use
  `timeout 10 sbx login < /dev/null` to capture output format only. Signing out is currently in effect
  on this machine, which is useful for testing the sign-in UI.
