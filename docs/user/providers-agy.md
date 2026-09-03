# Antigravity Accounts

This guide is for people who want to use more than one Antigravity account in T3 Code. For Codex, see
[Codex accounts](providers-codex.md). For Claude, see [Claude accounts](providers-claude.md).

Antigravity works differently from both. Codex and Claude keep their logins in files, so each
provider instance can point at its own config directory and two accounts can run side by side.
Antigravity keeps its login in the Windows Credential Manager, in a single entry that every `agy`
process on the machine shares. Only one account is logged in at a time.

T3 Code works with that rather than around it. Each Antigravity provider can name a saved account
profile, and T3 Code restores that profile into the shared entry just before it starts a session.
The CLI reads the entry once at startup and then holds the account for the life of the session, so
sessions that are already running keep their own account.

Account profiles are Windows only. On macOS, use the `agy-switch` function from
`~/.agy-profiles/agy-mac.sh` and leave the setting empty.

## Saving An Account Profile

A profile is a saved copy of one account's login under `~/.agy-profiles/<name>/`. T3 Code reads
profiles but never creates them, because creating one means logging in.

Save each account once, from a terminal:

```powershell
antigravity-account save a1
```

That command snapshots whichever account is logged in right now. To save a second account, log into
it inside `agy` first, then run the command again with a different name.

Check what you have saved:

```powershell
antigravity-account list
```

## Setting Up The Providers

Add one Antigravity provider per account, in Settings -> Providers -> Add provider, and set its
Account profile to the profile name:

```
Antigravity a1    Account profile: a1
Antigravity a2    Account profile: a2
Antigravity a3    Account profile: a3
```

Give each one a display name and accent color so they are easy to tell apart in the model picker.

Leaving Account profile empty keeps the old behavior: the provider uses whichever account is
currently logged in and never touches the credential.

## Which Account Am I Using?

Pick the provider in the model picker. Whatever you pick is the account that session runs as.

## Sessions Start One At A Time

Because all Antigravity sessions share one credential entry, T3 Code starts them one at a time. If
you start two sessions on different accounts at once, the second waits a few seconds for the first
to finish reading its login. You will see this as a short delay before the second session's first
response, and only when two sessions start close together.

## If An Account Looks Wrong

T3 Code only controls the credential entry while it is starting a session. Two things can still move
it underneath a running T3 Code:

- Running `a1`..`a6` or `antigravity-account switch` in a terminal.
- A second T3 Code server on the same machine.

Neither affects sessions that are already running, only ones that start afterward. If a session
looks like it is on the wrong account, start a new thread.

If a session fails to start with a message about a missing profile, the profile has not been saved
yet. Log into that account in a terminal and run `antigravity-account save <name>`.

## Can I Switch Accounts In An Existing Thread?

No. The account is fixed when the session starts. Start a new thread with the provider you want.

This is unlike Codex, where two providers sharing a `CODEX_HOME path` can swap accounts inside one
thread.
