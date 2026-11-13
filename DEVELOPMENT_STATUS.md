# Development status

Updated 2026-11-12. Cookie was quit and the October 25 dist app was deleted. Its Application Support database was not opened. `package-app.sh` was not run.

## 1. Current main, checkout, and installed app

| Item | State |
| --- | --- |
| `origin/main` and local `main` | `e54fe03` (2026-11-12 20:22 -0500). Merge commit of PR #13, on top of the #35 merge `283ff9b` and the handoff commit `57d61e5`. |
| Working tree | No stashes. One worktree: this checkout. |
| Main CI on `283ff9b` | [run 42157595317](https://github.com/johnkimec/cookie-agent/actions/runs/42157595317) failed before any job started. Annotation: "The job was not started because your account is locked due to a billing issue." All five jobs. Not a test failure. |
| Local check of #35 | `drive-mac-pid-test` at `b94e53d` exited 0 (`drive-mac pid test ok`). It skipped the bind-mount cases (`SKIP bind mount (not root)`). Fixture `ps` and `lsof` only. No app launch. |
| Running app | None. On 2026-11-12 the October 25 `dist/Cookie Agent.app` and `dist/Cookie Agent.app.bak-f866370` were deleted after Cookie quit. Its llama-server processes on ports 8080 and 8081 exited with it. `dist/` is empty. Application Support was not opened or deleted. |

## 2. Open pull requests

| PR | Head / base | What happened | Disposition |
| --- | --- | --- | --- |
| [#35](https://github.com/johnkimec/cookie-agent/pull/35) | `b94e53d`, merged | Merge commit `283ff9b`. Its remote branch is deleted. | **Done.** |
| [#13](https://github.com/johnkimec/cookie-agent/pull/13) | `8262209`, merged | Merge commit `e54fe03`. Merged with red checks because every job failed to start on the billing lock. Offline pid test had passed earlier. The Mac recipes were not run. Sub-features stay `planned`. | **Done.** |
| [#26](https://github.com/johnkimec/cookie-agent/pull/26) | `e7fbb8d` `cursor/drive-mac-ax-cleanup-c391` | Closed 2026-11-06 03:38 UTC. Remote branch still exists. | **Closed.** Branch kept. |

Lesson resolution on #13 is done. Each of `L-2026-11-03-133`, `134`, and `135` appears once, and the 135 text matches `main`.

## 3. Work to preserve

- `~/Library/Application Support/com.johnkimec.cookie-agent` was not touched. `dist/` is empty. A future build still belongs in a separate worktree: `package-app.sh` in this checkout writes `dist/Cookie Agent.app`.
- Remote branch `cursor/drive-mac-ax-cleanup-c391` (`e7fbb8d`), even though #26 is closed. Leftovers not on main: `CookieSkipHotkey`, `CookieApplicationSupportFolder`, `lsregister -u`, a total keystroke ban, owned embed reap, and the click-outside guard. None were extracted.
- Remote `cursor/drive-mac-recipes-1711` still exists after the merge. No open pull request points at it.
- Gitignored `verify-evidence/` and `dist/`. Merged pull-request branches were deleted on 2026-11-11. `main` was not changed by that delete.

## 4. Backlog

**Blocked**

- GitHub Actions will not start until the billing lock is cleared. The #35 merge has no post-merge CI.
- #13 is merged. Its CI, and CI on `main`, still does not start while the account is locked. Mac recipe runs still need a fresh OK and a separate worktree.

**Optional**

- A new PR for a #26 leftover, if you later want one. The option-space recipe on #13 conflicts with a total keystroke ban.
- Planned Mac sub-features, `memory-recall`, `memory-no-egress`, and the design-doc known issues N3, N4, R5-9, and R5-10.
- Build the menu-bar app from current main in a separate worktree, when you want to see it. Nothing is installed now.

**Done this pass**

- #35 merged. Offline pid test passed. The October 25 dist app was later deleted.
- #26 closed, branch retained.
- #13 merged as `e54fe03` without CI running. The pid test passed before that merge. The Mac recipes were not driven.

## 5. Integration order

1. Clear the GitHub billing lock, then rerun Actions on `e54fe03`. The previous failures are [main run 43340748138](https://github.com/johnkimec/cookie-agent/actions/runs/43340748138) and [#13 run 43155482141](https://github.com/johnkimec/cookie-agent/actions/runs/43155482141).
2. Mac recipe runs stay a separate approval. Use a new worktree. Never `package-app.sh` here.
3. Merged pull-request branches from the earlier cleanup stay deleted. `cursor/drive-mac-recipes-1711` and the closed #26 branch remain.

## 6. Smallest next task

No pull request is waiting. The next useful step is a Mac recipe run, and that still needs your OK in a separate worktree. CI can be rerun after the billing lock is cleared.
