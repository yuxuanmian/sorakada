# 003 Spec / Plan / Tasks Consistency Check

**Date**: 2026-09-18  
**Result**: PASS — no blocking contradiction found across the three primary documents.

## Structural checks

- Spec functional requirements are continuous from **FR-001 through FR-103** with no missing identifiers.
- Tasks contain **T001 through T099** in exact sequential order.
- Every spec functional requirement FR-001..FR-103 is explicitly referenced by at least one task.
- All ten user stories are represented in tasks (`US1` through `US10`).
- No unresolved clarification marker remains in the spec or plan.

## Cross-document semantic checks

| Decision | Spec | Plan | Tasks | Result |
|---|---|---|---|---|
| Zero documents are valid; no auto-Untitled | FR-012–FR-018, SR-001/002 | Nullable active document + Empty State | Phase 3 / US4 | Aligned |
| File > New / Ctrl+N / Tab `+` always create Untitled | FR-017, FR-023 | Explicit document New separated from Explorer creation | T018/T021 and US5 actions | Aligned |
| Workspace never owns/closes Tabs | FR-001–FR-011 | Independent WorkContext/document axes | US1 tasks | Aligned |
| Same canonical Workspace is a no-op | FR-005 | Compare identity before root reload/rebuild | T027/T028 | Aligned |
| Explorer is lazy; no recursive Workspace scan | FR-026, FR-032, SC-001/002 | Direct-child reads/cache only | US2 + T092/T093 | Aligned |
| `node_modules` is not auto-filtered | FR-032 | Real-project validation, no filter/index | US2 + T093 | Aligned |
| Tab switching does not locate/follow Tree | FR-038–FR-040 | Tree/Tab state independent | US3 | Aligned |
| Dropped directories are ignored | FR-045, FR-048 | Existing drop semantics retained | T046/T047 | Aligned |
| Shared command availability | FR-019–FR-024 | Lightweight `isEnabled`; scoped F2/Delete | Foundation + US8 | Aligned |
| Rename is disk-first and preserves document identity/state | FR-058–FR-064, FR-098–FR-103 | Rename orchestration + manager commit APIs | US6 | Aligned |
| Delete goes to OS trash, never permanent fallback | FR-065–FR-074 | Rust trash operation, failure remains failure | US7 | Aligned |
| Dirty Delete always warns, including edits during dialog | FR-069/070/073 | Revalidate dirty state before trash | T071/T072 | Aligned |
| Manual Refresh only, no watcher | FR-082–FR-089 | Reload loaded nodes only | US9 | Aligned |
| Symlink/junction browsing with ancestor-cycle stop | FR-034, SC-013 | Canonical ancestor-chain protection | T033/T038/T039/T095 | Aligned |
| Sidebar is generic, not a panel/plugin framework | FR-090–FR-097 | Minimal AppShell/Sidebar | T032 + US10 | Aligned |
| 002 Open/Save As/close safety gaps are repaired first | FR-099–FR-103 | Migration Phase 1 | Foundation T007–T010 | Aligned |

## Scope check

No task introduces the explicitly deferred feature sets: multi-root Workspace, file watcher, Workspace index/search, session restore, Git integration, Preview Tabs, split editor, Locate Current File, permanent Delete, generic Panel Registry, or generic Context Menu Registry.

Tree virtualization remains an optional implementation optimization only if realistic large-direct-child testing proves it necessary; it is not elevated into a product requirement.

## Refinements made during consistency review

1. Duplicate Open Folder now compares canonical Workspace identity **before** rereading/rebuilding Explorer, matching FR-005 more precisely.
2. Minimal generic AppShell/Sidebar composition is introduced before Explorer integration; US10 later adds visibility/width/resizing/polish instead of forcing a late shell rewrite.
3. Explorer `F2`/`Delete` remain local-focus triggers rather than global keymap entries, preventing normal editor Delete from being swallowed.
4. Task T090 was made concrete against existing/new pure-controller test files rather than relying on a vague optional React integration-test location.
5. Directory-context Refresh is required and invokes the same loaded-tree operation as the header and root context; its command wiring is placed in T083 after Refresh implementation.
6. SC-002 and Q3 now specify a bounded fixture and measurable root-read-to-selection timing.

## Conclusion

The three primary documents are internally consistent and ready to enter implementation. Future `speckit.analyze` can still be run as a final automated/agent review, but it should now function as a regression/omission check rather than the place where known 002→003 conflicts are first discovered.
