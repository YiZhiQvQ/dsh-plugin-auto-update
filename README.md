# dsh-plugin-update

English | [中文](README.zh.md)

A DeepSeek Harness bundle that answers "is there a newer version of my plugin?" and updates it in one click — from the plugin's own detail page.

## The problem it solves

A plugin installed into a DSH profile from npm stays at whatever version `pnpm` resolved the day it was added. Nothing in the Web UI tells you a newer version exists:

- the **Plugins** page offers *Update* only for the Official catalog entries the installation ships;
- `list_bundles` reports the installed version and the saved spec, never the published one;
- `install_bundle` refuses a package that is already installed (`already-installed`), so an update is always *remove, then install*.

That sequence is easy to get wrong by hand and easy to forget. This bundle performs it for you.

## What it adds

Nothing in the sidebar. It contributes to the Plugins page's detail view, so the controls sit next to the ones the page already draws:

| Where | What |
|---|---|
| Detail page head | **Check for updates** beside the bundle's own switch and uninstall |
| Beside the title | **New version 4.10.0**, when a newer one exists |
| Under the page content | Installed → newest, the registry that answered, and the reason when a check fails or the newest version needs a newer DSH |

The page it contributes to is a profile-installed bundle's own page, so a local link, a Git install, or an installation-provided bundle shows the reason it is not asked about instead of a button that cannot work.

It asks the same registries the profile's plugin manager asks, in the same order, so a profile behind `registry.npmmirror.com` is checked against the mirror rather than against npmjs.

Each bundle's check falls into five states:

- **update** — a newer version exists and `engines.dsh` (else the `@deepseek-ai/dsh` peer range) admits the running DSH version.
- **incompatible** — a newer version exists but requires a DSH this profile does not run. The requirement and its source are shown; no update button appears.
- **current** — the installed version is the newest one.
- **error** — the registry could not be read (offline, 404, a malformed document). The reason is shown, and **Check for updates** retries.
- **unsupported** — the dependency is a local link, a Git address, a tarball, or an alias. These are never touched.

Checking one page asks only that package: the other packages' registry documents come from a ten-minute cache.

## How an update runs

The Host half calls the profile's own `pluginManager` service, exactly as the Plugins page and the `plugin_manager` tool do:

1. `removeBundle(name)` — deselects the bundle, unloads its rows, and runs `pnpm remove`.
2. `installBundle(spec, { enabled, registry })` — installs the new version and reselects the bundle. `enabled` preserves a bundle the person had switched off.
3. If step 2 fails, the previous spec is installed again, so a failed update does not leave the plugin missing.

The saved spec keeps the range operator the dependency already used: `^4.8.1` becomes `^4.10.0`, not `4.10.0`. A profile that pinned an exact version stays pinned.

With HMR enabled, the replacement applies without a restart; a bundle that was running since startup reports `restart-required`, and the page says so.

The bundle refuses to update itself: removing it would unload the routes answering the request.

Two side effects come from the plugin manager, not from this bundle, and they are the same ones the shipped Update performs:

- The reinstalled bundle joins the **end** of `dsh.profile.bundles`. That order is configuration precedence, so a profile where two bundles override the same row sees the updated one win afterwards.
- A failed or cancelled installation after the removal leaves the package uninstalled; that is why the previous spec is installed again on failure.

## Configuration

None. The plugin manager's own `registry` and `fallbackRegistries` decide which registries are asked.

## HTTP surface

The Client half talks to the Host over three routes, because a plain-JS bundle cannot generate a `@Remote` namespace:

```
GET  /plugin-update/state    -> { ok, report, checking }
POST /plugin-update/check    -> { ok, report }           body: { refresh?: boolean, names?: string[] }
POST /plugin-update/update   -> { ok, result, report }   body: { name }
```

Mutations require the `x-plugin-update: 1` header, which a cross-site form cannot set and a cross-origin `fetch` cannot send without a CORS preflight these exact routes never answer.

## Install

Straight from GitHub, which needs no download first:

```sh
dsh plugin --profile <profile> install https://github.com/YiZhiQvQ/dsh-plugin-update
```

A local checkout, which tracks edits in place:

```sh
dsh plugin --profile <profile> install /absolute/path/to/dsh-plugin-update
```

From the [Releases](https://github.com/YiZhiQvQ/dsh-plugin-update/releases) page:

```sh
dsh plugin --profile <profile> install /absolute/path/to/dsh-plugin-update-0.1.0.tgz
```

A tarball records a `file:` dependency pinned to that file's path, so keep the `.tgz` where it is or reinstall after moving it. A directory records a `link:` dependency. A GitHub install records the Git address, which `pnpm` can fetch again at any time.

## Tests

```sh
node --test test/helpers.test.js test/update.test.js
node test/dry-run.mjs
```

`update.test.js` serves canned registry documents through the global `fetch`, so its assertions do not move when a package is published. `dry-run.mjs` mounts the real `apply` on a fake context, serves the routes over a real HTTP socket, and prints the report it builds; set `globalThis.__DSH_BUNDLES__` and `globalThis.__DSH_REGISTRIES__` before importing it to feed it fixtures.
