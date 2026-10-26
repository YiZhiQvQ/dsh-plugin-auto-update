## What it does

Adds update checking to each plugin's own detail page in the DSH Plugins page — no separate tab, no sidebar entry.

| Where | What |
|---|---|
| Detail page head | **检查更新 / Check for updates**, beside the bundle's own switch and uninstall |
| Beside the title | **有新版本 4.10.0 / New version 4.10.0**, when one exists |
| Under the page content | Installed → newest, the source that answered, and why a check was refused |

It answers for both sources that have a remote to ask:

- **npm** — the registry's `latest` tag, through the same registries the profile's plugin manager uses.
- **Git** — the `version` in the repository's `package.json` on its default branch. `github:`, `gitlab:`, `bitbucket:`, `git+https://`, and `git@host:owner/repo` all resolve.

A Git dependency names a branch, so an update reinstalls the same spec and lets the branch supply the new code. Local links, tarballs, aliases, and Git hosts with no readable raw file say why there is nothing to compare instead of offering a button that cannot work.

## Install

```sh
dsh plugin --profile <profile> install https://github.com/YiZhiQvQ/dsh-plugin-update
```

Or download the tarball below and install that path. A tarball records a `file:` dependency pinned to that file's location, so keep it where it is — a GitHub install records the Git address instead.

## Two things it will not do

- **It will not update itself.** Removing the bundle would unload the routes answering the request.
- **It will not touch a dependency with no remote.** `link:`, `file:`, tarball, and alias sources are reported and skipped.

## How an update runs

Through the profile's own `pluginManager`, the same sequence the shipped Update performs: `removeBundle`, then `installBundle` at the newer version, restoring the previous spec if the install fails. The saved range operator is kept — `^4.8.1` becomes `^4.10.0`, not `4.10.0`; an exact pin stays exact, and a Git dependency keeps its Git address.

A Git update re-clones the repository, so the host is proved reachable **before** anything is removed, under the same conditions the plugin manager's own `git` runs with. A host that needs a proxy `git` cannot see is refused while the plugin stays installed.

One side effect comes from the plugin manager rather than this bundle: the reinstalled bundle joins the end of `dsh.profile.bundles`, which is configuration precedence. A profile where two bundles override the same row sees the updated one win afterwards.

## Requirements

- DeepSeek Harness 0.2.x
- No dependencies, no build step, no install scripts

## Package

- 10 files, ~26 KB
- MIT
