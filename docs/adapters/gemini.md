# Threadline with Gemini CLI

Gemini CLI can use Threadline through its context file (`GEMINI.md` by default), through the CLI in its shell, and through MCP.

Configuration below was checked against the Gemini CLI documentation on 2026-09-13. If Gemini CLI changes its config format, trust the vendor docs over this page, and please open an issue. Antigravity setup has not been verified yet; any agent with a shell can use the CLI directly.

> Threadline is not published to npm yet. Until it is, build it (`npm install && npm run build`) and use `node /path/to/Threadline/dist/cli.js` wherever this page says `threadline`.

## 1. Install

```sh
npm install -g @threadline/cli
cd your-repo
threadline init
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
threadline render agents-md --write
```

**Or import it.** A `GEMINI.md` containing the line `@./AGENTS.md` pulls `AGENTS.md` in, and `threadline render gemini-md` recognizes the import instead of writing a second copy.

**Or give Gemini its own block:**

```sh
threadline render gemini-md            # preview
threadline render gemini-md --write    # add or update it in GEMINI.md
threadline render gemini-md --check    # in CI: exit 1 if missing or out of date
```

Only the text between `<!-- threadline:begin -->` and `<!-- threadline:end -->` is managed.

## 3. Agent identity

```sh
export THREADLINE_AGENT=gemini
```

Commands also accept `--agent gemini`.

## 4. MCP server (optional)

The CLI is enough for an agent that can run shell commands. MCP additionally gives Gemini typed tools (`resume`, `status`, `validate`, `task_start`, `task_claim`, `checkpoint_create`, `receipt_record`, `decision_add`, `knowledge_add`) and resources (`threadline://status`, `threadline://records/{id}`).

Add it with the Gemini CLI (project scope writes `.gemini/settings.json`):

```sh
gemini mcp add -s project -e THREADLINE_AGENT=gemini threadline threadline mcp
```

Unlike `codex mcp add` and `claude mcp add`, the command follows the server name directly, with no `--` separator. Gemini CLI uses `--` only to pass flags through to the server.

Or edit `settings.json`:

```json
{
  "mcpServers": {
    "threadline": {
      "command": "threadline",
      "args": ["mcp"],
      "env": { "THREADLINE_AGENT": "gemini" }
    }
  }
}
```

The server works on the Git repository containing its working directory. To pin a repository, set `"cwd": "/path/to/repo"`, or use `"args": ["-C", "/path/to/repo", "mcp"]`.

Leave `trust` unset unless you want Gemini to call Threadline's write tools without confirmation.

## What the server does not do

- It never runs commands. `receipt_record` records the result of a check Gemini already ran.
- It cannot mark anything `human-confirmed`. A person does that with the CLI and `--human <name>`.
- It writes only through the same code as the CLI, so records with secrets, unsafe paths, or schema errors are refused with the same messages.
