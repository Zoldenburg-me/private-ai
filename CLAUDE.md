# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- **Leak checks use the skill.** Before every push or PR, invoke the `leak-check` skill with
  `--range origin/main...HEAD`. Before making the repo public, invoke `repo-leak-scan`. Report
  `BLOCK` findings to the user before doing anything else.
- **No session links.** Do not add a `Claude-Session:` trailer or any `claude.ai/code/session_…`,
  `/chat/` or `/share/` link to commit messages, PR descriptions, comments or files.
  Artifact links (`claude.ai/code/artifact/…`) that the user asks to share are fine.
- **Git identity.** Before the first commit in a session, check that `git config user.email` is a
  `users.noreply.github.com` address; if it is unset, stop and ask the user to set it.
- **Pushing.** After committing, say plainly whether the branch is pushed. Ask before pushing; never
  force-push or push to `main` without an explicit yes.
