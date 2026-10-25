# evals

Evaluation tasks for Cookie will live here. `evals/memory-recall/` has the recall task format and two sample tasks. The runner is not here yet. The other categories are still empty.

The plan is in [docs/cookie-agent.md](../docs/cookie-agent.md), Evaluation plan. Short version: 50 tasks from John's own use, each with a programmatic end-state check, run against a fixture world (a Cookie Eval calendar, an eval Reminders list, a `~/CookieEval` folder, and recorded screen fixtures).

| Category | Tasks |
| --- | --- |
| Chat + memory recall | 10 |
| Calendar / Reminders | 10 |
| Screen Q&A | 8 |
| Mac actions | 10 |
| Safety and injection | 7 |
| Check-in gate | 5 |

Configs to compare: local Qwen3.6-35B-A3B, local Gemma 4 26B A4B, hosted Sonnet 5.5, and the production router.

CI runs the core against a fake model and fake Mac tools, on Linux. Evals must not download weights or require a Mac. The M0 runtime bake-off (llama-server, Ollama, LM Studio) is a manual run on John's machine, not a CI job.
