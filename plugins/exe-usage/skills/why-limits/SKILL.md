---
name: why-limits
description: Explain why the Claude usage limit is being consumed fast and what to change, from the user's own transcripts. Use for /why-limits, "why am I hitting my limit", "where do my tokens go", "usage limit", "rate limit analysis", "what is burning my quota".
---

The exe-usage plugin keeps rate-limit samples from the status line and can scan the local transcripts of the current window. Two levels:

| Ask | Run | Cost |
|---|---|---|
| numbers only, right now | `node "$EXE_USAGE_ROOT/bin/report.js" --hours 5` | none, no model call |
| the ranked explanation with actions | `node "$EXE_USAGE_ROOT/bin/analyze.js" --now` | one headless call on the configured analysis model, about a minute |

Rules:

- Start with the report when the user only wants to see where the tokens went. Run the analysis when they ask why or what to change.
- The analysis also sends its result to Telegram when a bot is configured. Add `--no-telegram` if the user only wants it here.
- Show the command output as is. It is already compact markdown; do not re-summarise the tables.
- If the report says "no rate-limit data", the status line is not installed or the plan has no windows; say so and point to `install.sh` and the `statusLine` setting.
- Never run the analysis in a loop. One run per request.
