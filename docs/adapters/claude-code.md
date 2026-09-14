# Aletheic with Claude Code

Claude Code can use Aletheic through its instruction file (`CLAUDE.md`), through the CLI in its shell, and through MCP.

Configuration below was checked against the Claude Code documentation on 2026-09-13. If Claude Code changes its config format, trust the vendor docs over this page, and please open an issue.

> Aletheic is not published to npm yet. Until it is, build it (`npm install && npm run build`) and use `node /path/to/Aletheic/dist/cli.js` wherever this page says `alethic`.

## 1. Install

```sh
npm install -g alethic
cd your-repo
alethic init
```

## 2. Instruction file

**Claude Code reads `CLAUDE.md`, not `AGENTS.md`.** Pick one of these setups.

**Share one block with Codex (recommended when both are used).** Keep the block in `AGENTS.md` and import it from `CLAUDE.md`:

```sh
alethic render agents-md --write
printf '@AGENTS.md\n' >> CLAUDE.md     # or add the line by hand
```

`@path` imports are resolved relative to the importing file. `alethic render claude-md` recognizes the import and does not write a second copy of the block.

**Or give Claude Code its own block:**

```sh
alethic render claude-md            # preview
alethic render claude-md --write    # add or update it in CLAUDE.md
alethic render claude-md --check    # in CI: exit 1 if missing or out of date
```

Only the text between `<!-- alethic:begin -->` and `<!-- alethic:end -->` is managed. `render` refuses to write through a `CLAUDE.md` symlink to `AGENTS.md`; run `render agents-md --write` instead.

## 3. Agent identity

```sh
export ALETHIC_AGENT=claude-code
```

Commands also accept `--agent claude-code`.

## 4. MCP server (optional)

The CLI is enough for an agent that can run shell commands. MCP additionally gives Claude Code typed tools (`resume`, `status`, `validate`, `task_start`, `task_claim`, `checkpoint_create`, `receipt_record`, `decision_add`, `knowledge_add`) and resources (`alethic://status`, `alethic://records/{id}`).

Share the server with everyone working on the repository (writes `.mcp.json`):

```sh
claude mcp add --scope project --transport stdio --env ALETHIC_AGENT=claude-code alethic -- alethic mcp
```

The resulting `.mcp.json`:

```json
{
  "mcpServers": {
    "alethic": {
      "command": "alethic",
      "args": ["mcp"],
      "env": { "ALETHIC_AGENT": "claude-code" }
    }
  }
}
```

Use `--scope local` (just you, this project) or `--scope user` (you, all projects) instead if you prefer.

Claude Code passes `CLAUDE_PROJECT_DIR` to the servers it starts, and `alethic mcp` uses it to find the repository. An explicit `-C /path/to/repo` (`args = ["-C", "/path/to/repo", "mcp"]`) takes precedence.

## What the server does not do

- It never runs commands. `receipt_record` records the result of a check Claude already ran.
- It cannot mark anything `human-confirmed`. A person does that with the CLI and `--human <name>`.
- Each MCP connection is recorded as its own session (`created_by.session`, an `mcp-…` id) unless `ALETHIC_SESSION` is set in the server's environment, so two Claude Code sessions working at once are told apart.
- It writes only through the same code as the CLI, so records with secrets, unsafe paths, or schema errors are refused with the same messages.
