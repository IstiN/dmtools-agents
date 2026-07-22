# `warmup-session.sh` — bootstrapping a dev-environment session

Prepares a fresh machine (cloud dev-environment session, Codespace, throwaway VM/container)
so that this repo's `agents` submodule works out of the box — clones the product repo
(with the `agents` submodule) and pre-installs/pre-warms the toolchain used by
`setup/install.sh` (java, node, dmtools, copilot, gradle, android, konan, ...).

It does **not** run the agent pipeline itself. Secrets (`JIRA_EMAIL`, `JIRA_API_TOKEN`,
`GH_TOKEN`/`PAT_TOKEN`, `COPILOT_GITHUB_TOKEN`, ...) must already be exposed as real
environment variables by whatever platform starts the session — `run-agent.sh` /
`run-teammate-local.sh` read those directly.

**Secret snapshot into `dmtools.env`**: the first time this script clones `--dir`
(not on later re-syncs of an already-cloned dir), it also snapshots whichever known
secret env vars are currently exported into `<dir>/dmtools.env` — the exact file
`run-agent.sh`/`run-teammate-local.sh` already load from. This exists because a
session template's env vars only live as long as the process/shell that started the
session; a cloud VM/container that later gets reconnected to or manually restarted
keeps its disk (repo + installed toolchain) but loses those env vars, so a fresh
ad-hoc shell would otherwise see `dmtools doctor` report every integration missing
and any `dmtools run ...`/SM invocation fail immediately with "Failed to create
TrackerClient instance" before the run even starts. The snapshot fixes that for any
later shell on the same disk. It never overwrites an existing `dmtools.env` (e.g. one
placed there by hand) and only writes vars matching a known secret-prefix pattern
(`JIRA_*`, `CONFLUENCE_*`, `FIGMA_*`, `GH_TOKEN`/`PAT_TOKEN`/`*GITHUB_TOKEN*`,
`GITLAB_*`, `BITBUCKET_*`, `ADO_*`, `RALLY_*`, `TESTRAIL_*`, `BITRISE_TOKEN`, `XRAY_*`,
`GEMINI_*`/`OPENAI_*`/`ANTHROPIC_*`/`BEDROCK_*`/`DIAL_*`/`OLLAMA_*`, `DEFAULT_TRACKER`,
`DEFAULT_LLM`) — if the session template exposes secrets under different names, add
them to `SECRET_VAR_PATTERN` in the script, or place a `dmtools.env` manually.

All examples below use a placeholder repo `your-org/your-product-repo` on branch `main`,
with the toolchain installed except `cursor`/`codemie`/`kimi`/`maestro`/`playwright`
(swap in whichever tools your project doesn't need — see `setup/install.sh` for the full
list). Replace with your actual repo, branch, and tool list.

## Usage

```bash
warmup-session.sh --repo <git-url> --dir <target-dir> [--branch <name>] \
  [--exclude "tool1 tool2 ..."] [--install-args "extra args for install.sh"]
```

| Flag | Meaning |
|---|---|
| `--repo` | Git URL of the product repo (the one that has `agents` as a submodule). |
| `--dir` | Local directory to clone into (or sync, if it already exists). |
| `--branch` | Checkout/track this branch instead of the repo's default. |
| `--exclude` | Space-separated tool names to skip (forwarded to `install.sh all` as `-tool1 -tool2 ...`). |
| `--install-args` | Extra raw arguments appended to the `install.sh` invocation. |

Idempotent: re-running against an existing `--dir` does `git fetch` + `checkout` +
`pull --ff-only` + `submodule update --init --recursive` instead of cloning again, so the
same command works for both first-time warmup and later re-warmups.

## Cloud dev-environment templates (e.g. Bitrise Dev Environments)

Most cloud dev-environment products split session bootstrap into a **warmup** script
(runs once, when the session is first created — good place for the heavy clone +
toolchain install) and a **startup** script (runs on every session start/restart — keep
this fast, just a repo sync).

**Warmup script field:**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Private repo: a fresh session has no credential helper and no TTY, so a
# plain `git clone https://github.com/...` fails with "could not read
# Username ... Device not configured". Authenticate before the FIRST clone
# (warmup-session.sh itself repeats this line internally for everything it
# clones/fetches afterwards, but that's too late for this bootstrap clone).
# Skip this line entirely if your-org/your-product-repo is public.
git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"

git clone --recurse-submodules https://github.com/your-org/your-product-repo.git repo
bash repo/agents/scripts/warmup-session.sh \
  --repo https://github.com/your-org/your-product-repo.git \
  --dir repo \
  --branch main \
  --exclude "cursor codemie kimi maestro playwright"
```

(The first `git clone` bootstraps the directory so `agents/scripts/warmup-session.sh`
exists to call; the script itself is idempotent, so this is safe even though it clones
twice on a truly fresh session.)

**Startup script field** (every session start/restart — just sync, no reinstall):

```bash
#!/usr/bin/env bash
set -euo pipefail

# Needed again here for private repos: the `git config --global` from the
# warmup script only persists if the session's home directory is on a
# persistent disk carried over between starts. Setting it unconditionally in
# both scripts is cheap and avoids depending on that persistence guarantee.
git config --global url."https://x-access-token:${GH_TOKEN}@github.com/".insteadOf "https://github.com/"

cd repo
git fetch origin
git checkout main
git pull --ff-only origin main
git submodule update --init --recursive
```

**Template variables** (mark secrets as *Secret* + *Expose as env var*, so they land as
real environment variables the AI agent scripts pick up directly):

- `JIRA_EMAIL`, `JIRA_API_TOKEN` (secret)
- `GH_TOKEN` / `PAT_TOKEN` — needs push access to `your-org/your-product-repo` (secret)
- `COPILOT_GITHUB_TOKEN` (or whatever `AI_AGENT_PROVIDER` your project uses needs) (secret)
- `JIRA_BASE_PATH`, `JIRA_AUTH_TYPE`, `CONFLUENCE_BASE_PATH`, `AI_AGENT_PROVIDER`,
  `COPILOT_MODEL` — not secret, fine as plain template variables

## GitHub Codespaces / `devcontainer.json`

Codespaces has the same two-phase model: `onCreateCommand` (once, at container creation —
equivalent to "warmup") and `postStartCommand` (every start — equivalent to "startup").
Codespaces already checks out the repo itself, so there's no need to `git clone` — just
init submodules and run the script against the existing checkout.

```jsonc
// .devcontainer/devcontainer.json
{
  "name": "your-product-repo",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "onCreateCommand": "git submodule update --init --recursive && bash agents/scripts/warmup-session.sh --repo https://github.com/your-org/your-product-repo.git --dir . --branch main --exclude \"cursor codemie kimi maestro playwright\"",
  "postStartCommand": "git fetch origin && git submodule update --init --recursive"
}
```

Secrets go in **Codespaces → Repository/Organization secrets** (Settings → Secrets and
variables → Codespaces) with the same names as above — GitHub injects them as real
environment variables into every Codespace automatically, so no extra wiring is needed
beyond naming them consistently with what `run-agent.sh` / `run-teammate-local.sh`
expect.

## Plain CI runner / local machine

Works the same way outside any dev-environment product — just run it directly with
secrets already exported in the shell (or sourced from a `dmtools.env` you manage
yourself, if you're not using this script's target machine as a shared session):

```bash
export JIRA_EMAIL=... JIRA_API_TOKEN=... GH_TOKEN=... COPILOT_GITHUB_TOKEN=...
bash warmup-session.sh --repo https://github.com/your-org/your-product-repo.git \
  --dir ~/work/your-product-repo --branch main
```
