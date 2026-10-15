<!--
Sync Impact Report
- Version change: unratified template -> 1.0.0
- Modified principles:
  - Template Principle 1 -> I. User Data Is Inviolable
  - Template Principle 2 -> II. State Has One Owner
  - Template Principle 3 -> III. Contracts Are Verified From Both Sides
  - Template Principle 4 -> IV. Commands Have One Execution Path
  - Template Principle 5 -> V. Scope and Complexity Must Be Earned
- Added sections:
  - Engineering Constraints
  - Development Workflow and Quality Gates
- Removed sections: none; template placeholders were resolved
- Follow-up TODOs: none
-->
# Sorakada Constitution

## Core Principles

### I. User Data Is Inviolable
Sorakada MUST preserve user-authored text and supported file-format characteristics unless the
user explicitly requests a transformation. Only a successful disk write may advance the saved
baseline or change the active Save As path. A cancelled or failed read or write MUST leave the
active document, destination, format metadata, and dirty state consistent with the last successful
operation. Any operation that could discard dirty content MUST pass through the unsaved-work guard.
This principle is non-negotiable because a text editor that silently changes or loses data is not
trustworthy.

### II. State Has One Owner
Each mutable fact MUST have one authoritative owner. CodeMirror owns the live document text; it
MUST NOT be mirrored into React state. Application document orchestration owns path, format, saved
baseline, and dirty-state transitions. Rust owns raw bytes, BOM handling, line-ending conversion,
and filesystem I/O; `src-tauri/src/file_codec.rs` is the only module that may interpret or produce
raw file bytes. Cross-layer communication MUST use explicit contracts rather than duplicate state
or hidden normalization. Clear ownership prevents races, stale views, and divergent behavior.

### III. Contracts Are Verified From Both Sides
Behavioral changes MUST be covered at the lowest layer that can prove them and at every affected
contract boundary. TypeScript/Vitest tests and Rust tests MUST remain synchronized for changes to
the Tauri IPC wire contract. Regression tests MUST cover failure, cancellation, dirty-state, and
snapshot semantics whenever those paths are affected. A change is incomplete until type checking,
frontend tests, the production build, and Rust tests all pass. Cross-language verification is
required because either half can compile while disagreeing with the other at runtime.

### IV. Commands Have One Execution Path
Every user-visible action MUST be represented by a stable application command and executed through
one canonical handler, regardless of whether it originates from a menu, keyboard shortcut, window
event, or future UI control. A single invocation MUST execute exactly once. Destructive actions
MUST reuse the same guard and lifecycle logic rather than reproduce it at each entry point. This
keeps behavior consistent, makes commands independently testable, and prevents duplicate dispatch.

### V. Scope and Complexity Must Be Earned
Implementation MUST satisfy the approved specification with the smallest architecture that
preserves correctness and future changeability. New dependencies, abstractions, persistent state,
background behavior, or parallel input paths require a concrete current requirement and an
explicit justification in the feature plan. Speculative systems and out-of-scope product behavior
MUST NOT be introduced during feature implementation. Simplicity is a correctness constraint in a
desktop editor whose lifecycle already spans UI, editor, IPC, and native filesystem layers.

## Engineering Constraints

- Sorakada remains a Tauri desktop application with a React/TypeScript frontend, CodeMirror editor,
  and Rust native backend unless an approved plan documents a migration.
- The frontend MUST operate on logical Unicode text. Encoding, BOM, line-ending, and byte-level
  filesystem concerns MUST remain in Rust.
- IPC payloads and errors MUST be explicit, serializable, and tested on both sides of the boundary.
- Platform-specific behavior MUST be documented in the relevant specification and isolated where
  practical; platform defaults MUST NOT be mistaken for universal text semantics.
- Errors visible to users MUST preserve the pre-operation document state and provide enough context
  to understand that the requested operation did not complete.

## Development Workflow and Quality Gates

Every feature begins with an approved specification defining user scenarios, edge cases, measurable
success criteria, and explicit exclusions. Its plan MUST include a Constitution Check before design
work and repeat that check after design. Tasks MUST preserve the ownership boundaries in this
constitution and identify tests for affected failure paths and contracts.

Before work is reported complete, all of the following gates MUST pass from a clean understanding
of the current worktree:

1. `npm run typecheck`
2. `npm run test`
3. `npm run build`
4. `cargo test` from `src-tauri`

Native dialogs, menus, accelerators, window-close interception, and other behavior not adequately
covered by automated tests MUST be validated against the feature quickstart or acceptance matrix.
Reviewers MUST reject changes that weaken saved-baseline semantics, duplicate live text state,
bypass canonical commands, or alter an IPC contract without synchronized tests.

## Governance

This constitution is the highest project-level engineering authority. Feature specifications,
plans, tasks, reviews, and implementation guidance MUST comply with it; when they conflict, this
document prevails.

Amendments require a written proposal that states the affected principles, explains the reason and
migration impact, updates the Sync Impact Report, and receives explicit maintainer approval before
dependent implementation proceeds. Constitution versions use semantic versioning: MAJOR for a
principle removal or incompatible redefinition, MINOR for a new principle or materially expanded
governance obligation, and PATCH for clarification without changed obligations.

Every feature plan and code review MUST include a compliance check. Any exception MUST be narrowly
scoped, documented in the plan's Complexity Tracking section, justified with rejected simpler
alternatives, and approved by a maintainer. Exceptions do not amend this constitution and expire
with the work that required them.

**Version**: 1.0.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-09-19
