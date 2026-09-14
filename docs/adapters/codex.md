# Alethic with Codex

Codex can use Alethic through its instruction file (`AGENTS.md`), through the CLI in its shell, and through MCP.

Configuration below was checked against the Codex documentation on 2026-09-13. If Codex changes its config format, trust the vendor docs over this page, and please open an issue.

> Alethic is not published to npm yet. Until it is, build it (`npm install && npm run build`) and use `node /path/to/alethic/dist/cli.js` wherever this page says `alethic`.

## 1. Install

```sh
npm install -g alethic
cd your-repo
alethic init
```

## 2. Instruction file

Codex reads `AGENTS.md`. It looks in the project root (the directory containing `.git`) and every directory down to where it was started, joining the files root-first. The combined size is capped by `project_doc_max_bytes`, 32 KiB by default, so the Alethic block is kept short.

```sh
alethic render agents-md            # preview the block
alethic render agents-md --write    # add or update it in AGENTS.md
alethic render agents-md --check    # in CI: exit 1 if missing or out of date
```

Only the text between `<!-- alethic:begin -->` and `<!-- alethic:end -->` is managed. Everything else in `AGENTS.md` is left as it is.

## 3. Agent identity

Records say which agent wrote them. Set the name once in the environment Codex runs commands in:

```sh
export ALETHIC_AGENT=codex
```

Commands also accept `--agent codex`.

## 4. MCP server (optional)

The CLI is enough for an agent that can run shell commands. MCP additionally gives Codex typed tools (`resume`, `status`, `validate`, `task_start`, `task_claim`, `checkpoint_create`, `receipt_record`, `decision_add`, `knowledge_add`) and resources (`alethic://status`, `alethic://records/{id}`).

Add it with the Codex CLI:

```sh
codex mcp add alethic --env ALETHIC_AGENT=codex -- alethic mcp
```

Or edit `~/.codex/config.toml` (all projects) or `.codex/config.toml` in the repository:

```toml
[mcp_servers.alethic]
command = "alethic"
args = ["mcp"]
env = { ALETHIC_AGENT = "codex" }
```

The server works on the Git repository containing its working directory. To pin a repository, set `cwd = "/path/to/repo"` in the table, or pass `-C`: `args = ["-C", "/path/to/repo", "mcp"]`.

## What the server does not do

- It never runs commands. `receipt_record` records the result of a check Codex already ran.
- It cannot mark anything `human-confirmed`. A person does that with the CLI and `--human <name>`.
- Each MCP connection is recorded as its own session (`created_by.session`, an `mcp-…` id) unless `ALETHIC_SESSION` is set in the server's environment, so two Codex sessions working at once are told apart.
- It writes only through the same code as the CLI, so records with secrets, unsafe paths, or schema errors are refused with the same messages.
