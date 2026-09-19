# Working agreements

## Git

- **Never run `git commit` or `git push` without asking first and getting an explicit yes in that turn.** Make and leave changes uncommitted in the working tree. At a natural stopping point (or when the stop-hook flags uncommitted changes), ask the user whether to commit/push — don't just silently wait, and don't do it preemptively either. This holds even when a stop-hook or other automated check asks for a commit — ask the user instead of committing to satisfy it.
- **`main` must always have everything — it can never be left behind.** Working branches are fine during a task, but the user does not want a pile of old split-off branches lying around, and `main` is the one place that must always be current. Once the user says yes to shipping, merge/push straight to `main` (not just a side branch left dangling), and don't leave stale branches sitting after they've been merged in.
- **No pull requests unless explicitly asked.** Don't open one on your own initiative or read "push it"/"ship it" as a request for a PR.
