## What it does

Adds update checking to each plugin's own detail page in the DSH Plugins page — no separate tab, no sidebar entry.

| Where | What |
|---|---|
| Detail page head | **检查更新 / Check for updates**, beside the bundle's own switch and uninstall |
| Beside the title | **有新版本 4.10.0 / New version 4.10.0**, when one exists |
| Under the page content | Installed → newest, the registry that answered, and why a check was refused |

It only appears on a bundle installed from a registry into this profile. Local links, Git installs, tarballs, aliases, and installation-provided bundles say why npm is not asked instead of offering a button that cannot work.

## Install

```sh
dsh plugin --profile <profile> install https://github.com/YiZhiQvQ/dsh-plugin-update
```

Or download the tarball below and install that path. A tarball records a `file:` dependency pinned to that file's location, so keep it where it is — a GitHub install records the Git address instead.

## Two things it will not do

- **It will not update itself.** Removing the bundle would unload the routes answering the request.
- **It will not touch a non-registry dependency.** `link:`, `file:`, Git, tarball, and alias sources are reported and skipped.

## How an update runs

Through the profile's own `pluginManager`, the same sequence the shipped Update performs: `removeBundle`, then `installBundle` at the newer version, restoring the previous spec if the install fails. The saved range operator is kept — `^4.8.1` becomes `^4.10.0`, not `4.10.0`; an exact pin stays exact.

One side effect comes from the plugin manager rather than this bundle: the reinstalled bundle joins the end of `dsh.profile.bundles`, which is configuration precedence. A profile where two bundles override the same row sees the updated one win afterwards.

## Requirements

- DeepSeek Harness 0.2.x
- No dependencies, no build step, no install scripts

## Package

- 10 files, ~21 KB unpacked from ~63 KB
- MIT
