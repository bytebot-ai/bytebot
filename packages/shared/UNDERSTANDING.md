# Bytebot Shared – Package Understanding

_Last updated: <!-- timestamp placeholder -->_

This workspace hosts all **cross-package TypeScript definitions and helper utilities**.  It is published as `@bytebot/shared` and imported by **agent**, **daemon**, and **UI** to guarantee type-safety for message blocks, computer actions, and conversion helpers.

---
## 1. Structure
```
packages/shared
└─ src
   ├─ index.ts                     (barrel exports)
   ├─ types/
   │   ├─ computerAction.types.ts  – Canonical schema for low-level actions
   │   └─ messageContent.types.ts  – Anthropic-style content blocks + tool variants
   └─ utils/
       ├─ computerAction.utils.ts  – Converters & type-guards for actions ↔ tool blocks
       └─ messageContent.utils.ts  – Extensive type-guards for content blocks
```

---
## 2. Core Type Families
### 2.1 ComputerAction (12-variant union)
Represents every actionable command the daemon can execute, also mirrored by MCP tools.

Key discriminant field: `action` string. Variants include:
* `move_mouse`, `trace_mouse`, `click_mouse`, `press_mouse`, `drag_mouse`
* `scroll`, `type_keys`, `press_keys`, `type_text`
* `wait`, `screenshot`, `cursor_position`

Each variant has a matching **ToolUse** block schema (same name prefix `computer_`).

### 2.2 MessageContentBlock hierarchy
Implements Claude's content-block system:
* `Text`, `Image`
* `ToolUse` (generic)
  * Specialised **computer_* blocks** (see above)
  * `set_task_status`, `create_task`
* `ToolResult`

The union simplifies serialisation to Prisma `Json` and inter-service transmission.

---
## 3. Utility Functions
### 3.1 computerAction.utils.ts
* Per-variant `isXAction(obj)` type guards.
* `convertXActionToToolUseBlock(action, id)` helpers – used by `InputTrackingService` to wrap captured native events into LLM-readable blocks.

### 3.2 messageContent.utils.ts
* Rich set of type guards (e.g., `isComputerToolUseContentBlock`, `isScreenshotToolUseBlock`, etc.) to safely pattern-match incoming Claude responses.
* `getMessageContentBlockType()` – debugging helper returning string description.

These utils enable the Agent to **narrow types** when iterating over Claude responses and the UI to render messages appropriately.

---
## 4. Publication & Consumption
`next.config.ts` in UI transpiles this package (`transpilePackages`) so TS sources can be imported directly without pre-build.
Other packages simply `import { MessageContentType, convertClickMouseActionToToolUseBlock } from '@bytebot/shared';`.

No runtime code, purely a **dev-time dependency**; thus no external env vars or side effects.

---
## 5. Future Enhancements
1. **Runtime Validation** – Consider zod schemas alongside TS types to validate incoming JSON payloads before casting.
2. **Versioning** – As the protocol evolves, introduce semver and changelog to prevent breaking changes across packages.
3. **Doc Generation** – Use `typedoc` to auto-publish API reference for integrators.

---
## 6. Status & Next Steps
All four core packages now have `UNDERSTANDING.md`.  Next phase: map **inter-package communication flow** and perhaps generate sequence diagrams for typical task lifecycle. 