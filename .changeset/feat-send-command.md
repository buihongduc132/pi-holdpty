---
"holdpty": minor
---

feat: add `send` command for non-exclusive input injection

New `holdpty send <session> <text>` command that writes input to a session's PTY without taking an exclusive writer lock. Unlike `attach`, multiple senders can run concurrently alongside an attached client and viewers.

Also supports `--stdin` for piping data: `echo "exit" | holdpty send worker1 --stdin`

This is useful for orchestration tools, CI/CD scripts, and multi-agent systems that need to inject commands programmatically without conflicting with interactive sessions.
