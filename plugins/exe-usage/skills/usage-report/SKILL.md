---
name: usage-report
description: Weekly or daily Claude Code token usage report by model, effort, project, tool results and plugin cost, from local transcripts. Use for /usage-report, "usage report", "how many tokens this week", "token usage by project", "send my usage to Telegram".
---

Run:

```
node "$EXE_USAGE_ROOT/bin/report.js" --days 7
```

Options: `--hours N` for a shorter window, `--json` for raw data, `--telegram` to also send the markdown file to the configured bot.

Show the output as is. When the user asks what to change, hand over to `/why-limits`.
