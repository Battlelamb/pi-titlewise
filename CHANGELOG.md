# Changelog

## 1.0.0 - 2026-11-06
- First public release as a Pi package.
- Manual `/titlewise` now gets the full 30 s budget (was 8 s, which timed out on cold models).
- Bundles the generic Titlewise skill; a skill installed at `~/.agents/skills/titlewise/SKILL.md` still takes precedence.
- Hardening: the skill file is size/type checked before it enters the prompt; added tests for Jev and no-Jev auto titles and for the skill loader.
