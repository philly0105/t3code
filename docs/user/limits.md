# Check account limits

The Limits page shows how much of each provider account's subscription quota is spent right now.
Open it from **Limits** in the sidebar's bottom bar, next to Usage.

This is different from the Usage page. Usage reconstructs historical token spend from the
providers' own session history. Limits shows the live quota your provider reported, such as a
five-hour window at 87% with the time it resets, so you can tell whether an account still has room
before you start a turn.

Each configured account gets a row, using the display name and accent color you set in provider
settings. A row marked **limit reached** means the provider rejected the last request for that
account.

## Readings arrive during turns

Claude Code and Codex publish their quota while a turn is running, not on demand. Until an account
has run at least one turn since the server started, it has nothing to show. After that the page
holds the last reading and labels how old it is, so a row can be minutes or hours stale. Refresh
re-reads what each environment currently knows; it does not make providers re-report.

## Antigravity

Antigravity publishes no quota, so its rows show tokens instead of windows: the tokens and turns
T3 Code has driven through that account since the server started. Because Antigravity's accounts
share one credential store on your machine, T3 Code is the only thing that can attribute a turn to
the account that ran it. These counters restart when the server restarts.
