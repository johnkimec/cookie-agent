# Development status

Updated 2026-11-11. The running Cookie was not signaled, and its Application Support database was not opened. `package-app.sh` was not run.

## 1. Current main, checkout, and installed app

| Item | State |
| --- | --- |
| `origin/main` and local `main` | `283ff9b` (2026-11-06 03:36 UTC). Merge commit of PR #35. Fast-forwarded this checkout from `29bc749`. |
| Working tree | No stashes. One worktree: this checkout. |
| Main CI on `283ff9b` | [run 42157595317](https://github.com/johnkimec/cookie-agent/actions/runs/42157595317) failed before any job started. Annotation: "The job was not started because your account is locked due to a billing issue." All five jobs. Not a test failure. |
| Local check of #35 | `drive-mac-pid-test` at `b94e53d` exited 0 (`drive-mac pid test ok`). It skipped the bind-mount cases (`SKIP bind mount (not root)`). Fixture `ps` and `lsof` only. No app launch. |
| Running app | Unchanged. Process 70767 is still `dist/Cookie Agent.app` (mtime 2026-10-25 19:33:52). llama-server still on `127.0.0.1:8080` and `:8081`. No git SHA in the binary. `e957eca` remains an unproven fit for that build time. |

## 2. Open pull requests

| PR | Head / base | What happened | Disposition |
| --- | --- | --- | --- |
| [#35](https://github.com/johnkimec/cookie-agent/pull/35) | `b94e53d`, merged | Merge commit `283ff9b`. Its remote branch is deleted. | **Done.** |
| [#13](https://github.com/johnkimec/cookie-agent/pull/13) | `8262209` `cursor/drive-mac-recipes-1711` → `main` | Open and mergeable. Brought up to `283ff9b`. Lessons 133 and 134 kept once; `L-2026-11-03-135` appended. `drive-mac` auto-merge keeps the guarded option-space send and calls `drive_owned_llama_pids`. Offline pid test passed. Not merged to `main`. CI jobs failed in 2–3s: billing lock, same as main. | **Keep.** Do not merge until CI can run. |
| [#26](https://github.com/johnkimec/cookie-agent/pull/26) | `e7fbb8d` `cursor/drive-mac-ax-cleanup-c391` | Closed 2026-11-06 03:38 UTC. Remote branch still exists. | **Closed.** Branch kept. |

Lesson resolution on #13 is done. Each of `L-2026-11-03-133`, `134`, and `135` appears once, and the 135 text matches `main`.

## 3. Work to preserve

- Running app, `dist/Cookie Agent.app`, `dist/Cookie Agent.app.bak-f866370`, and `~/Library/Application Support/com.johnkimec.cookie-agent`. Do not run `package-app.sh` in this checkout.
- Remote branch `cursor/drive-mac-ax-cleanup-c391` (`e7fbb8d`), even though #26 is closed. Leftovers not on main: `CookieSkipHotkey`, `CookieApplicationSupportFolder`, `lsregister -u`, a total keystroke ban, owned embed reap, and the click-outside guard. None were extracted.
- Remote and local `cursor/drive-mac-recipes-1711` (`8262209`).
- Gitignored `verify-evidence/` and `dist/`. Merged pull-request branches were deleted on 2026-11-11. `main` was not changed by that delete.

## 4. Backlog

**Blocked**

- GitHub Actions will not start until the billing lock is cleared. The #35 merge has no post-merge CI.
- #13 is current with `main` but its CI did not start. Do not merge it while the billing lock is in place. Mac recipes still need a fresh OK and a separate worktree.

**Optional**

- A new PR for a #26 leftover, if you later want one. The option-space recipe on #13 conflicts with a total keystroke ban.
- Planned Mac sub-features, `memory-recall`, `memory-no-egress`, and the design-doc known issues N3, N4, R5-9, and R5-10.
- Rebuild the menu-bar app from current main. The running binary does not include #35 or the earlier memory and popup merges.

**Done this pass**

- #35 merged. Offline pid test passed. Live app left running.
- #26 closed, branch retained.
- #13 updated to `8262209` with only lesson 135 added. Pid test passed again on that merge. Not merged to `main`.

## 5. Integration order

1. Clear the GitHub billing lock, then rerun Actions on `283ff9b` and on #13 (`8262209`). [Main run 42157595317](https://github.com/johnkimec/cookie-agent/actions/runs/42157595317). [#13 run 43155482141](https://github.com/johnkimec/cookie-agent/actions/runs/43155482141).
2. Merging #13 needs a separate yes after those checks can actually run.
3. Mac recipe runs stay a separate approval. Use a new worktree. Never `package-app.sh` here.
4. Merged pull-request branches are deleted. The open #13 branch and the closed #26 branch stay.

## 6. Smallest next task

Clear the GitHub billing lock and rerun CI. Nothing else is waiting on a merge.
