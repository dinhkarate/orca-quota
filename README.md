# Agent Quota

An Orca plugin that shows how much plan limit and credit is left for every agent account on the
machine, on one screen, instead of one provider at a time. A status bar item names the provider
closest to running out (`Claude 12%`) and its tooltip lists every provider; the **Agent Quota**
panel shows each account's windows, reset times and balances.

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
not stop the account, so they only count when there is nothing else.

## What it never does

- **It never refreshes a token.** Refreshing rotates the token and can sign the agent's own CLI
  out. An expired login shows `sign-in expired: run <agent> once to refresh it`.
- **It never runs a command from a config file.** pi and omp let a key be `!command`; those keys
  are skipped. Put that key in the Keys section instead.
- Credentials go only to their own provider's API. Keys you add in the panel are kept in Orca's
  encrypted plugin secrets.

Not covered yet: DeepSeek Harness logs in to a DeepSeek platform account with no public balance
API, so only DeepSeek API keys are read. omp's `models.yml` is YAML and is not read (its
`auth.json` is). Gemini CLI, Cursor, Kimi, Z.ai and MiniMax are read through 9router only.

## Settings

Under Settings → Plugins → Agent Quota: refresh interval (default 5 minutes; Claude's usage
endpoint rate-limits frequent reads), providers to leave out of the status bar, the 9router URL,
whether to read pi and omp configs, and an on/off switch per provider.

## Develop

```sh
orca plugin validate .
orca plugin test .          # parsers, status bar summary, credential discovery, worker, panel
orca plugin check .         # renders the panel with the worker reading this machine's logins
orca plugin dev watch .     # loads this folder into Orca; Ctrl-C unloads it
```

The worker runs its own code with your user account's access, so Orca asks you to approve it
first; the install prints the exact `--approve <fingerprint>` command.

The endpoints and headers follow the usage clients in [Orca](https://github.com/stablyai/orca)
and [9router](https://github.com/decolua/9router) (MIT).

## License

MIT
