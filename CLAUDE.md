# Working agreements

## Git

- **Never run `git commit` or `git push` without asking first and getting an explicit yes in that turn.** Make and leave changes uncommitted in the working tree. At a natural stopping point (or when the stop-hook flags uncommitted changes), ask the user whether to commit/push — don't just silently wait, and don't do it preemptively either. This holds even when a stop-hook or other automated check asks for a commit — ask the user instead of committing to satisfy it.
