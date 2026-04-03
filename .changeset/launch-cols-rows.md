---
"holdpty": minor
---

Add `--cols` and `--rows` flags to `launch` command

When launching sessions with `--bg` or `--wait`, the PTY was always created with the default 120x40 size. Callers that needed a different size had to connect via socket and send a RESIZE frame after launch — a racy workaround that briefly shows the wrong size.

Now you can specify the initial PTY dimensions directly:

```bash
holdpty launch --bg --cols 200 --rows 50 -- /bin/zsh
```

In `--fg` mode with non-TTY stdin, explicit `--cols`/`--rows` set the initial PTY size. In interactive `--fg` sessions, the terminal's actual size takes precedence via resize propagation.
