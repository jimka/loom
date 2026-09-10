# Loom

A local desktop code editor built on `@jimka/typescript-ui`, packaged with
Tauri — see [README.md](README.md) for architecture and the dev workflow,
[TODO.md](TODO.md) for the backlog and known issues.

## This is a typescript-ui demo app — library-first, always

Loom exists to exercise `@jimka/typescript-ui` at real-application scale, the
same role [SQLAdmin](https://github.com/jimka/sqladmin) plays for the
library. Every screen should be built from the library's own components and
layouts, not new dependencies or hand-rolled UI.

- **Before building or changing any UI, read the library's capability
  manifest**: `node_modules/@jimka/typescript-ui/llms.txt`. It indexes every
  component, layout, and data-layer class by task — start there, not by
  grepping the library's source for something that looks related. Grepping
  source is what already missed `ToolBar` for the sidebar rail (found only
  after the fact, because a prompt pointed straight at specific files instead
  of the manifest) — the manifest exists precisely so that mistake doesn't
  happen.
- If a sibling checkout of [SQLAdmin](https://github.com/jimka/sqladmin) is
  available locally, treat it as a second reference: it is the library's own
  most thorough worked example, and the direct precedent for this project's
  own rail/toolbar/activity-bar-style UI.
- **Hand-roll a component only when the manifest and a source check both
  confirm there's no good existing candidate** for the task. Composing or
  subclassing an existing library piece beats a new one-off Loom component.
- **Never paper over a library bug or a missing library capability with a
  Loom-specific workaround.** If something Loom needs is really a gap in the
  library — a missing method, a missing component, a behavior that belongs
  upstream rather than special-cased here — stop and ask the user how to
  proceed instead of quietly building around it. This is what already gave
  `Tab.setTabGlyph`, `Tab.setTabItalic`, `Tab.setTabModified`, and
  `AbstractSelectableList`'s row-level `setEnabled` a chance to be built into
  the library itself, instead of living as Loom-only special cases.

## Workflow

- When producing implementation plans, use the plan skill.
- When implementing implementation plans, use the implement skill.
- When reviewing, auditing, or critiquing a change, use the audit skill.
- When committing changes, use the commit skill.
