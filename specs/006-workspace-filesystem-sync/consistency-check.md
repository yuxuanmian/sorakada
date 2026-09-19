# 006 Spec / Plan / Tasks Consistency Check

**Date**: 2026-09-19  
**Method**: Speckit-analyze-style, read-only cross-artifact review after task generation, followed by explicit remediation of the findings listed below and a second validation pass.  
**Result**: **PASS — no unresolved CRITICAL/HIGH contradiction or uncovered frozen requirement remains.**

## Structural checks

- `spec.md` contains six user stories (`US1`–`US6`) with independent tests and acceptance scenarios.
- Functional requirements are continuous from **FR-001 through FR-118** with no missing/duplicate identifiers.
- Superseded requirements are continuous from **SR-001 through SR-003**.
- Success criteria are continuous from **SC-001 through SC-012**.
- `tasks.md` contains **T001 through T134** in exact sequential order.
- `tasks.md` contains an explicit requirement traceability table covering **all FR-001..FR-118, SR-001..SR-003, SC-001..SC-012 and US1..US6**.
- No unresolved clarification marker, implementation placeholder, or draft token remains in the three primary artifacts.
- The four Constitution/AGENTS quality gates are present as explicit final tasks: `npm run typecheck`, `npm run test`, `npm run build`, and `cargo test` from `src-tauri`.

## Current Specification Analysis Report

| ID | Category | Severity | Location(s) | Summary | Result |
|---|---|---|---|---|---|
| C1 | Constitution | — | spec/plan/tasks | User-data safety remains with DocumentManager/005; watcher callbacks never directly mutate document text; Rust remains filesystem/native-identity owner. | PASS |
| C2 | Consistency | — | spec FR-001–027; plan §§1–7; tasks T014–T047 | Watcher events are hints, one-level reconciliation is filesystem truth, and all directory-read sources converge on one Explorer-owned reconciliation path. | PASS |
| C3 | Consistency | — | spec FR-037–067; plan §§3,8–12; tasks T005–T030, T048–T069, T116–T121 | Rename/move continuity requires opaque filesystem-object proof and never replaces canonical path ownership semantics. | PASS |
| C4 | Coverage | — | tasks Requirement Traceability | Every frozen FR/SR/SC and every user story maps to implementation and/or verification tasks. | PASS |
| C5 | Cross-feature | — | 003 FR-028/082/087 + SC-003; 006 SR-001–003 | 006 explicitly supersedes manual-only external convergence and cached re-expansion-without-read, while preserving Manual Refresh's all-loaded-directories behavior. | PASS |
| C6 | Cross-feature | — | 004 inline-edit rules; 006 FR-082/083/087/088 | Background reconciliation does not redefine blur/Enter semantics; only invalidated edit targets/contexts cancel automatically, while explicit Manual Refresh retains 003/004 cancellation behavior. | PASS |
| C7 | Cross-feature | — | 005 FR-037–040; 006 compatibility section; plan §§1,10–11 | 005 stays the opened-document content consumer. 006 adds a separate Workspace consumer and routes confirmed path relocation back through DocumentManager + 005 validation. | PASS |
| C8 | Performance | — | spec FR-068–083/105–118; SC-002/003/009/010; tasks T070–T109 | Event storms, periodic passes and overflow recovery remain bounded by represented state and never become a recursive Workspace crawler. | PASS |

## Analyze findings remediated before this final pass

The first analysis pass found several code-aware gaps that were resolved in the artifacts before packaging:

1. **Mixed-scope watcher invalidation** — 005 and 006 can legally share one physical directory with different logical scopes. The plan/tasks now preserve the existing invalidation DTO but derive invalidations from logical `(scope, watchedPath)` interests and require consumer-side filtering, so a 006-only recursive invalidation does not spuriously trigger 005-wide validation.
2. **Direct-created Explorer node identity** — adding `objectIdentity` to directory listings was insufficient because existing New File/New Folder inserts a Tree node directly. The plan/tasks now require that fast path to copy `CreateWorkspaceEntryResult.identity.objectIdentity` immediately.
3. **Canonical watcher path vs logical Workspace path** — recursive backend events can use canonical/native spelling while Explorer uses `WorkContext.rootPath`, especially for symlink/junction/equivalent roots. `WatchEvent` now has planned per-subscription relative-path fields and 006 must rebase those onto the logical root instead of comparing raw watcher paths to Tree paths.
4. **Unrepresented Move target vs lazy loading** — preserving an open document across a provable move must not force Explorer to load an unrepresented target parent. The plan/tasks now separate Tree continuity from document-only relocation: DocumentManager may prove/adopt the new target while Explorer remains lazy.
5. **Pre-mutation source verification ambiguity** — the earlier draft left open whether to add a structural-entry IPC. The final plan chooses the existing one-level parent directory read as the authoritative pre-Rename/Delete source-object check; no extra IPC is introduced in 006.
6. **Storm responsiveness criterion** — the vague phrase “responsive enough” was replaced with deterministic scheduler behavior: user selection/expansion reads must execute ahead of remaining background recovery backlog.
7. **Root read → watcher arming gap** — the final plan/tasks require one generation-safe root reconciliation after a recursive subscription becomes live when Explorer is already installed; otherwise the later normal initial root load supplies the authoritative post-watch read.

## Cross-document semantic checks

| Decision | Spec | Plan | Tasks | Result |
|---|---|---|---|---|
| Reuse 005 watcher; no second watcher framework | FR-001/009/010 | §§1–2 | T014–T023, T123 | Aligned |
| 005 non-recursive + 006 recursive interests may share one directory safely | FR-009/010 | §2 | T014–T023 | Aligned |
| Watcher is a hint; directory read is truth | FR-013–027 | §§4,6–8 | T024–T047, T070–T083 | Aligned |
| No recursive Workspace scan during watch/recovery/periodic work | FR-004/022/072/117 | §§6–7,13–14 | T031–T047, T070–T096, T125 | Aligned |
| Never-loaded directories are not background-loaded | FR-023/029/036 | §§6–8 | T040–T047, T066 | Aligned |
| Loaded-collapsed: watcher hint may reconcile; periodic skips; re-expand reconciles | FR-074–076 | §13 | T089–T092 | Aligned |
| Manual Refresh still rereads all loaded nodes incl. collapsed | FR-080–082, SR-003 | §§7,13 | T077–T078, T124 | Aligned |
| Rename/move continuity only with native object proof | FR-037–053 | §§3,8–10 | T005–T030, T048–T069 | Aligned |
| Hard links/symlinks do not become global Tree deduplication | FR-038/041/047/090 | §§3,8,17 | T024–T029, T068, T114–T115 | Aligned |
| Recursive watcher path maps to logical root via relative path | FR-118 | §§2,6 + IPC | T019/T021/T039/T041/T066 | Aligned |
| Dirty open files may follow confirmed relocation without losing edits | FR-056–061 | §§10–11 | T054–T067 | Aligned |
| External relocation cannot steal an already-owned/reserved destination | FR-062–065 | §10 | T056–T060, T120 | Aligned |
| 005 validates content after relocation; 006 never clears content conflicts itself | FR-060/061/116 | §11 | T060–T064, T126 | Aligned |
| Internal Rename/Delete re-proves selected object immediately before mutation | FR-066 | §12 | T116–T119 | Aligned |
| Event storm/overflow discards detail and recovers root + expanded only | FR-068–073/106 | §§13–14 | T070–T096 | Aligned |
| Workspace watcher failure != root unavailable | FR-007/008/095/096 | §§5,15 | T099–T106 | Aligned |
| External root move is not followed | FR-054/055/098 | §15 | T103–T106 | Aligned |
| Stale Workspace/watch/read work cannot commit after replace/close | FR-005/006/100–112 | §§5,7,15 | T031–T035, T097–T109 | Aligned |
| Normal automatic convergence is silent; no new notification framework | FR-093/094 | §§5,18 | T099–T100, T125–T126 | Aligned |

## Scope check

No task requires any explicitly deferred system: multi-root Workspace, Workspace index/search, Git integration, persistent filesystem event history, watcher exclude/settings UI, recursive/unbounded Expand All, Tree drag/drop Move UI, Copy/Cut/Paste, automatic moved-root following, or a new notification framework.

No implementation task instructs the agent to create an alternative DocumentManager, Explorer manager, watcher framework, path-ownership model, byte/text codec, or generic transaction/event-bus abstraction.

## Coverage Summary

| Inventory | Count | Covered |
|---|---:|---:|
| Functional requirements | 118 | 118 (100%) |
| Superseded requirements | 3 | 3 (100%) |
| Buildable success criteria | 12 | 12 (100%) |
| User stories | 6 | 6 (100%) |
| Tasks | 134 | 134 structurally assigned |

**Ambiguity count (unresolved)**: 0  
**Duplication count (harmful/unresolved)**: 0  
**Constitution conflicts**: 0  
**Critical issues**: 0  
**High issues**: 0

## Conclusion

The current `spec.md`, `plan.md`, and `tasks.md` are mutually consistent and compatible with the current 003/004/005 contracts after the explicit 006 supersedes above. The documents are ready to enter implementation on `feature-core`.

---

## Post-implementation re-validation

**Date**: after implementation and manual verification. The review above is the pre-implementation record and is kept unchanged.

**Result**: **PASS — the implementation matches the frozen artifacts; 156/156 tasks are complete.**

- **Structure**: `tasks.md` now contains **T001–T156**, extended by four converge passes (Phase 10: T135–T144; Phase 11: T145–T153; Phase 12: T154–T155; Phase 13: T156). The requirement traceability table still covers every FR/SR/SC and all six user stories, and no frozen requirement was dropped.
- **Constitution and gates**: `npm run typecheck`, `npm run test` (23 files / 744 tests), `npm run build` and `cargo test` (145 tests) all pass on `feature-core`, re-run on the restored tree after the mutation checks below.
- **Convergence findings closed**: the Phase-10 tasks removed what a post-implementation assessment found — background work now requires a represented **and already read** directory (FR-023/FR-029); watch handshakes and batch windows are bound to one WorkContext generation (FR-005/FR-100/SC-007); a case-only relocation still forces the 005 content validation (FR-046/FR-061); an inline rename whose own target moved is cancelled (FR-087); adoption notifies the UI (FR-057); user-read priority, the real collapsed-directory exclusion and the 100k periodic sweep are pinned by tests (SC-002/SC-003/SC-009); and the pre-mutation source check matches by leaf name before requiring identity (FR-066). The Phase-11 pass tightened continuity to require *equal non-null* object identities (FR-034/FR-042), serialized the watcher decide → native call → confirm sequence (FR-009/FR-011), refused relocation onto a destination an in-flight Open owns (FR-062/FR-065), stopped the periodic/expanded sweep at a collapsed ancestor without clearing its state (FR-074), and handed stale drain work to the new drain (FR-100).
- **Phase-12 findings closed**: the two remaining places that still inferred the platform's case rule in TypeScript are gone. The comparison contract is now reported by Rust per directory (`WorkspaceDirectoryResult.case_sensitive`) and gates the pre-mutation case-folded fallback (Constitution I, FR-066), and external-relocation containment is derived only from canonical comparison keys instead of a lowercased tail comparison (FR-045/FR-056/FR-058). Each fix is mutation-checked: restoring the previous code path fails the corresponding regression, and the four gates were re-run afterwards.
- **Phase-13 finding closed**: the contract those two fixes read had to become truthful. `case_sensitive` no longer infers the rule from the platform or from a case-colliding pair in the current listing; Rust asks the directory itself (the Windows `FileCaseSensitiveInfo` flag, the authoritative platform rule elsewhere) and resolves an unavailable answer conservatively to case-sensitive. `comparison_key`, `relative_within` and the directory result all share that one component-aware rule, so a case-sensitive directory keeps its names distinct in path ownership, in containment, in relocation source keys and in the pre-mutation source check. Native coverage pins the rule against what the filesystem actually does, and a case-sensitive directory *model* with no colliding names covers the case no portable test can create.
- **Accepted residual limitation**: an external relocation whose old path's parent directory no longer exists cannot have its canonical old-source relation proven, so no document is rebound; the document stays bound and 005 remains authoritative rather than the frontend guessing. This is the conservative reading of FR-042/FR-045 and is recorded in `tasks.md`.
- **Manual verification**: the eight scenarios from `plan.md` "Integration/manual validation" were executed by the reporter on a real desktop session and passed. The one defect it surfaced — the root read failure being rendered as a Tree row, which overlapped neighbouring rows — is fixed (root failures are projected once through the panel-level unavailable notice, and load notices now grow instead of being clipped to a fixed row height) and was re-verified visually.
- **Safety gates** from `plan.md` still hold at the code level: no watcher callback mutates Explorer or DocumentSession; no continuity is inferred without non-null object identity; `comparisonKey` remains the only path-ownership key; no watcher/overflow/periodic path recurses through the Workspace; external relocation returns through 005 validation; and a stale generation cannot commit.
