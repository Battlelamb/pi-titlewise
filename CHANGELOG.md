# Changelog

## 1.0.1 - 2026-11-06
- Generation now always uses the active model (removed the hardcoded `openai/gpt-6-luna` preference).
- Small-model robustness: the JSON-only rule is restated after the conversation, a single wrapping code fence is tolerated, and the automatic title token budget is 4096 so reasoning models can finish.

## 1.0.0 - 2026-11-06
- First public release as a Pi package.
- Manual `/titlewise` now gets the full 30 s budget (was 8 s, which timed out on cold models).
- Bundles the generic Titlewise skill; a skill installed at `~/.agents/skills/titlewise/SKILL.md` still takes precedence.
- Hardening: the skill file is size/type checked before it enters the prompt; added tests for Jev and no-Jev auto titles and for the skill loader.
