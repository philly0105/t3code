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

## Check limits from chat

For Claude Code, Codex, and Antigravity, open the composer's slash-command menu and select
`/usage`. T3 Code asks the selected provider account for its current quota without starting a turn
or spending tokens. The result appears above the composer and also updates that account on the
Limits page.

Other providers do not offer this command. Their limits can appear only when the provider reports
them during a turn.

## Last-known readings

Claude Code and Codex also publish quota while a turn is running. The Limits page keeps the newest
reading for each account and labels how old it is, so a row can be minutes or hours stale. Refresh
re-reads what each environment currently knows; it does not ask providers for a new reading. Use
`/usage` when you need a current value.

## Antigravity

Antigravity reports quota when you select `/usage`. Before the first check, its row shows the tokens
and turns T3 Code has driven through that account since the server started. Because Antigravity's
accounts share one credential store on your machine, T3 Code is the only thing that can attribute a
turn to the account that ran it. These counters restart when the server restarts.
