# Aletheic with Gemini CLI

Gemini CLI can use Aletheic through its context file (`GEMINI.md` by default), through the CLI in its shell, and through MCP.

Configuration below was checked against the Gemini CLI documentation on 2026-09-13. If Gemini CLI changes its config format, trust the vendor docs over this page, and please open an issue. Antigravity setup has not been verified yet; any agent with a shell can use the CLI directly.

> Aletheic is not published to npm yet. Until it is, build it (`npm install && npm run build`) and use `node /path/to/Aletheic/dist/cli.js` wherever this page says `alethic`.

## 1. Install

```sh
npm install -g alethic
cd your-repo
alethic init
```

## 2. Context file

Gemini CLI reads `GEMINI.md` unless `context.fileName` says otherwise. Pick one of these setups.

**Read `AGENTS.md` too (recommended when Codex is also used).** In `.gemini/settings.json` in the repository (or `~/.gemini/settings.json`):

```json
{
  "context": { "fileName": ["AGENTS.md", "GEMINI.md"] }
}
```

Then keep the block in `AGENTS.md`:

```sh
alethic render agents-md --write
```

**Or import it.** A `GEMINI.md` containing the line `@./AGENTS.md` pulls `AGENTS.md` in, and `alethic render gemini-md` recognizes the import instead of writing a second copy.

**Or give Gemini its own block:**

```sh
alethic render gemini-md            # preview
alethic render gemini-md --write    # add or update it in GEMINI.md
alethic render gemini-md --check    # in CI: exit 1 if missing or out of date
```

Only the text between `<!-- alethic:begin -->` and `<!-- alethic:end -->` is managed.

## 3. Agent identity

```sh
export ALETHIC_AGENT=gemini
```

Commands also accept `--agent gemini`.

## 4. MCP server (optional)

The CLI is enough for an agent that can run shell commands. MCP additionally gives Gemini typed tools (`resume`, `status`, `validate`, `task_start`, `task_claim`, `checkpoint_create`, `receipt_record`, `decision_add`, `knowledge_add`) and resources (`alethic://status`, `alethic://records/{id}`).

Add it with the Gemini CLI (project scope writes `.gemini/settings.json`):

```sh
gemini mcp add -s project -e ALETHIC_AGENT=gemini alethic alethic mcp
```

Unlike `codex mcp add` and `claude mcp add`, the command follows the server name directly, with no `--` separator. Gemini CLI uses `--` only to pass flags through to the server.

Or edit `settings.json`:

```json
{
  "mcpServers": {
    "alethic": {
      "command": "alethic",
      "args": ["mcp"],
      "env": { "ALETHIC_AGENT": "gemini" }
    }
  }
}
```

The server works on the Git repository containing its working directory. To pin a repository, set `"cwd": "/path/to/repo"`, or use `"args": ["-C", "/path/to/repo", "mcp"]`.

Leave `trust` unset unless you want Gemini to call Aletheic's write tools without confirmation.

## What the server does not do

- It never runs commands. `receipt_record` records the result of a check Gemini already ran.
- It cannot mark anything `human-confirmed`. A person does that with the CLI and `--human <name>`.
- Each MCP connection is recorded as its own session (`created_by.session`, an `mcp-…` id) unless `ALETHIC_SESSION` is set in the server's environment, so two Gemini sessions working at once are told apart.
- It writes only through the same code as the CLI, so records with secrets, unsafe paths, or schema errors are refused with the same messages.
