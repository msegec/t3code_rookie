# T3 Code Rookie, MZS fork

Our maintained fork of [T3 Code](https://github.com/pingdotgg/t3code), built
from official nightlies with our extra features and fixes applied on top.
Get our builds from [MZS releases](https://github.com/msegec/t3code_rookie/releases).
The installation commands in the upstream README below install official T3 Code.

## What our version adds

This list describes [our published build](https://github.com/msegec/t3code_rookie/releases/tag/v0.0.41-nightly.20260916.1795.mzs.r3260c2d3083c)
compared with its official base, [nightly 1795](https://github.com/pingdotgg/t3code/releases/tag/v0.0.41-nightly.20260916.1795).
Newer upstream nightlies may already contain some of these changes.

- Project sidebar colours and icons, with an accent editor in Project Settings.
- Project Settings opens the checkout selected in the sidebar and shows its icon
  and accent. Group settings use the same representative checkout as the sidebar.
  Tracked in [upstream PR #11406](https://github.com/pingdotgg/t3code/pull/11406).
- Colour previews inside code blocks.
- Upload, rename and delete files directly in the files view.
- Compressed file previews keep their content type so HTML previews render correctly.
- Usage totals that finish even when some connected devices are offline.
- OpenCode usage history, source-specific totals, and explicit provider coverage.
  Cursor and Antigravity history remain unavailable.
- Remaining allowance in Usage > Limits for Grok, Cursor, OpenCode Go and
  OpenRouter key caps, beside Codex and Claude. Accounts without quota data stay
  listed with the reason. Free-model request counts are not exposed by OpenRouter
  or OpenCode Zen and show as unavailable.
- GitHub repository search when adding projects, with clearer empty results.
- Cursor model discovery avoids creating disposable chats.
- A visible context-window meter and Cursor/Grok subagent activity panels.
- Browser previews carried over the existing T3 connection for remote work.
- Desktop connected to an existing background service keeps its local server
  disabled through updates and recovery. Browser previews can reuse a connected
  local service. The disable switch itself ships upstream since nightly 1780.
- MZS desktop and server updates, with checks that the replacement server starts
  and keeps its connection details.
- Full upstream and fork release notes in the desktop update prompt.
- Release files for Linux x64, Windows x64 and macOS (Intel and Apple silicon)
  build on our own machine. Linux and Windows arm64 wait on an aarch64 terminal
  module our build kit cannot produce yet.

The overlay list on `main` matches this build. Nothing is queued.

## How our releases work

`/t3-fleet-release` takes an official nightly, reapplies our saved changes
(called overlays), and checks that the combined app builds and passes its tests.
If changes clash, we repair them before building. `build-local` reuses the exact
source and verified artifacts between attempts, builds locally, then checks every
file before an authorised GitHub upload. It uses no GitHub Actions build minutes.
Uploads remain drafts until the separate publish step verifies the complete set.
Published downloads reach clients through their normal update flow.

Cross-built downloads record their build host, source, tool pins, checksums and
whether their executable smoke test ran in `build-provenance.json`. Local macOS
builds are ad hoc signed ZIPs, without notarisation or a DMG. The pinned Node
runtime cannot produce a macOS Intel CLI archive; the Intel desktop is included.
A cross-built file is not evidence that it ran on that operating system. The
legacy hosted workflow is unavailable at the current controls revision.

The [overlay list](.mzs/overlays.json) selects the changes for the next build.
Each release records its exact nightly and applied changes in its release notes
and `mzs-fleet.json` asset. Those records show what actually shipped.

This README lives on the fork's `main` branch. Release builds use a separate
checkout and do not overwrite it. When updating from upstream, preserve this
fork introduction and refresh the upstream section below. The release skill
reviews this list each run and updates the published comparison after a
successful release, removing differences that the selected base already includes.

## Upstream README

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
