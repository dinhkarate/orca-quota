# Agent Usage

An Orca plugin that counts the tokens every coding agent on the machine has used (Claude Code, Codex, pi, omp, Grok, OpenCode, dsh, Antigravity), and what they
cost, by day, agent, model and project. It reads the agents' own logs, so it needs no API key and
sends nothing anywhere. The status bar shows today's total (`1.1B · $530`); the **Agent Usage**
panel shows any range with a daily chart and a breakdown. A **Quota** tab shows the plan limits
and credits left on each account.

## Usage

| Agent       | Log it reads                                                    | Cost                         |
| ----------- | --------------------------------------------------------------- | ---------------------------- |
| Claude Code | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`)       | API list price               |
| Codex       | `~/.codex/sessions` and `archived_sessions`, `.jsonl` and `.jsonl.zst` (or `$CODEX_HOME`) | API list price |
| pi          | `~/.pi/agent/sessions/*/*.jsonl`                                | what pi logged, else list price |
| omp         | `~/.omp/agent/sessions/*/*.jsonl`                               | what omp logged, else list price |
| Grok CLI    | `~/.grok/sessions/*/*/updates.jsonl`                            | what Grok logged             |
| OpenCode    | `~/.local/share/opencode/opencode.db`, read only                | what OpenCode logged, else list price |
| dsh         | `~/.dsh/sessions/*/*/session.v4.jsonl.zstd`                     | API list price               |
| Antigravity CLI | `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript_full.jsonl`; the model from its conversation database | API list price |

- **Tokens** are input, output, cache reads and cache writes added up. Reasoning is part of
  output and is also shown on its own.
- **List prices** come from [LiteLLM's price table](https://github.com/BerriAI/litellm), downloaded
  once a day (turn this off in Settings). A subscription such as Claude Max or ChatGPT Pro does not
  bill per token, so for those agents the cost is what the same tokens would cost on the API.
  Tokens on a model with no price are counted and shown as unpriced.
- **Projects** are the working folder each session ran in, named by its last two folders.
- The first read goes through every log once; that takes about half a minute for a few GB of
  logs. After that the plugin reads only the lines added since the last read, every minute.
- The totals are kept in `~/.local/share/orca-agent-usage/usage-index.json` (or
  `$XDG_DATA_HOME`), so history stays after an agent deletes its old logs (Claude Code does after
  30 days by default). Delete that file to count everything again from the logs.
- Claude Code writes a response once per content block; each response is counted once. A response
  copied into a resumed session's new log is counted again, which adds well under 1%.

## Quota

| Provider    | What it shows                                              | Where the login comes from                                                         |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Claude      | 5-hour and weekly limits, per-model weekly limits, extra usage | Claude Code's login (macOS Keychain, else `~/.claude/.credentials.json`); pi's `anthropic` login |
| Codex       | ChatGPT plan windows (5-hour, weekly), code review, credits | `$CODEX_HOME/auth.json` (default `~/.codex`); pi's `openai-codex` login             |
| Grok        | SuperGrok weekly credits or monthly budget                 | `~/.grok/auth.json`; pi's `xai` login                                              |
| Copilot     | Premium requests (paid) or chat and completions (free)     | `gh auth token`; pi's `github-copilot` login                                       |
| OpenRouter  | Key limit and account credits                              | Keys section, `OPENROUTER_API_KEY`, pi/omp `auth.json` and `models.json`           |
| DeepSeek    | API balance                                                | Keys section, `DEEPSEEK_API_KEY`, pi/omp `auth.json` and `models.json`             |
| 9router     | Every active account in the pool, as 9router reports it (Codex, Claude, Antigravity, Copilot, Qoder, Kiro, GLM, Kimi, …) | The 9router pi or omp send requests to (or the URL in Settings), with its CLI token from the Keys section or `NINE_ROUTER_CLI_TOKEN` |

A pool counts its best account: a router moves to whichever account still has room, so the
provider is only out when every account is. An account's own headroom is its tightest
account-wide window (5-hour, weekly); per-model windows (Antigravity models, Codex review) do
not stop the account, so they only count when there is nothing else. When a provider drops
below 25% left, the status bar adds it after today's usage (`1.1B · $530 · Claude 5%`).

## What it never does

- **It never writes to an agent's files.** Logs and OpenCode's database are only read.
- **It never refreshes a token.** Refreshing rotates the token and can sign the agent's own CLI
  out. An expired login shows `sign-in expired: run <agent> once to refresh it`.
- **It never runs a command from a config file.** pi and omp let a key be `!command`; those keys
  are skipped. Put that key in the Keys section instead.
- Credentials go only to their own provider's API. Keys you add in the panel are kept in Orca's
  encrypted plugin secrets. The price download sends nothing about your usage.

Not covered yet: DeepSeek Harness logs in to a DeepSeek platform account with no public balance
API, so its quota is not shown (its token usage is). omp's `models.yml` is YAML and is not read
for keys (its `auth.json` is). Gemini CLI, Cursor, Kimi, Z.ai and MiniMax quotas are read through
9router only.

## Settings

Under Settings → Plugins → Agent Usage: whether to download model prices, how often quota is
read (default 5 minutes; Claude's usage endpoint rate-limits frequent reads), quota providers the
status bar skips, the 9router URL, whether to read pi and omp configs, and an on/off switch per
quota provider.

## Develop

```sh
orca plugin validate .
orca plugin test .          # log parsers, the index, prices, report, quota, worker, panel
orca plugin check .         # renders the panel with the worker reading this machine's logs
orca plugin dev watch .     # loads this folder into Orca; Ctrl-C unloads it
```

The worker runs its own code with your user account's access, so Orca asks you to approve it
first; the install prints the exact `--approve <fingerprint>` command.

The quota endpoints and headers follow the usage clients in [Orca](https://github.com/stablyai/orca)
and [9router](https://github.com/decolua/9router) (MIT).

## License

MIT
