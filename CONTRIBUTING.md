# Contributing to The System

Thanks for your interest in the project. Note that the code is published under an
all-rights-reserved license (see the README) — open an issue to discuss before starting
work, so we can agree on scope and terms first. The workflow below keeps `main` clean
without enforced branch protection.

## Golden rule

**Never commit directly to `main`.** All changes go through a Pull Request and at least one review.

## Workflow

1. **Pick up an issue.** Comment on it (or open one) so others know it's being worked. Check the [Project board](https://github.com/users/sidharth18jam/projects/2).
2. **Branch off `main`:**
   ```bash
   git checkout main && git pull
   git checkout -b feature/short-description   # or fix/… , chore/…
   ```
3. **Commit in small, clear units.** Write present-tense messages: `Add turn-loop state machine`.
4. **Open a Pull Request** against `main`. Fill in the PR template.
5. **Request review.** @sidharth18jam is auto-requested via CODEOWNERS. Wait for at least **one approval** before merging.
6. **Merge** once approved and green. Prefer "Squash and merge" to keep history tidy. Delete the branch after.

## Branch naming

| Prefix | Use for |
|--------|---------|
| `feature/` | New functionality |
| `fix/` | Bug fixes |
| `chore/` | Tooling, docs, refactors |

## Linking work

Link the issue a PR closes with `Closes #N` in the PR body, and explain the rules-level reasoning behind any change to game behaviour.

## Keeping main mergeable

- Rebase or merge `main` into your branch before requesting review if it has drifted.
- Don't force-push to `main`. Force-push only your own feature branches.
