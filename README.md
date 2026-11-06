# pi-titlewise

Pi extension that names your sessions.

- **Auto-rename:** on a fresh session (`/new` or a new start), the first real message gets a title like `Fix login redirect loop - 2026-11-06`. A final title is set at shutdown. Resumed sessions and names you set yourself are never overwritten.
- **`/titlewise [topic]`:** shows title suggestions in several styles (English/long/suffix and more). It never renames; apply one with `/name`.

## Install

```bash
pi install npm:@battlelamb/pi-titlewise
```

## Works with or without Jev

Auto-rename, `/titlewise`, the title checks and shutdown refresh behave the same either way; only the final pick differs.

## Jev (optional)

If the `typesafe` provider is logged in (`pi auth print-api-key --provider typesafe` succeeds), [Jev](https://typesafe.ai) picks the best candidate. Without it, the first valid candidate is used. Nothing else changes. See [SECURITY.md](SECURITY.md) for exactly what is sent.

## Notes

- Candidates are generated with `openai/gpt-6-luna` when your registry has it, otherwise with the active model.
- Only a short generated synopsis and candidate titles go to Jev, never the raw transcript.
- To customise prompts, install your own skill at `~/.agents/skills/titlewise/SKILL.md`; it overrides the bundled one.
- Based on [claude-code-conversation-titler](https://github.com/Battlelamb/claude-code-conversation-titler) (MIT).

## Test

`npm test`
