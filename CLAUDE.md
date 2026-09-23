# Working agreements

## Verify the target before starting work

Before doing any real work in a session, confirm this checkout is actually the one the user
cares about — don't assume the attached repo/branch is "the" project just because it's what
the session opened with. Concretely:

- If the user describes seeing something (a version number, a screen, a behavior) that
  doesn't match what's in this checkout after a rebuild, stop and ask what repo/branch/URL
  they're actually looking at before doing more work — don't keep rebuilding and re-pushing
  the same place hoping it'll eventually match.
- A user can have multiple similarly-named repos/forks under different owners for the same
  project, each with its own independent history. Never assume "the game" means this repo
  just because its name matches — ask, or check with the user, if there's any doubt.
- This confusion already cost a full session once (2026-09-22): work went into
  `unlimited-data-universe/emberashes033` while the user's actual running server pulled from
  a different repo (`EvaristoCabrito/emberashes3d`) with its own separate, more advanced
  history. Losing time to that mismatch is avoidable — a two-line check at the start isn't.

## Git

- **Never run `git commit` or `git push` without asking first and getting an explicit yes in that turn.** Make and leave changes uncommitted in the working tree. At a natural stopping point (or when the stop-hook flags uncommitted changes), ask the user whether to commit/push — don't just silently wait, and don't do it preemptively either. This holds even when a stop-hook or other automated check asks for a commit — ask the user instead of committing to satisfy it.
