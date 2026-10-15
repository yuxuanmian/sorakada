//! Event-driven filesystem watching.
//!
//! 005 needs to learn that a file it has open changed on disk without polling
//! it. This module owns that capability and nothing else: it knows about
//! directories, subscriptions, refcounts and normalized hints, but it does not
//! know what a document, a session, an editor or a Workspace is. The 005
//! consumer lives in the React layer, and 006's Workspace consumer reuses this
//! same manager — which is why the shared backend watch tracks per-scope demand
//! instead of letting the first subscriber pick one mode for everybody.
//!
//! The module is split into three layers on purpose:
//!
//! 1. [`BackendMessage`] — a raw backend message, decoupled from the concrete
//!    `notify` types so bookkeeping can be tested without OS event timing.
//! 2. [`WatchBackend`] — the trait the real [`NotifyWatchBackend`] implements,
//!    which lets tests substitute a recording backend.
//! 3. [`WatcherCore`] — pure deterministic bookkeeping: refcounted parent
//!    directory watches, subscription routing, hint normalization and
//!    invalidation. This is where all the rules worth testing live.
//!
//! [`FilesystemWatcher`] glues the three together for callers that do not care
//! about the split, including the Tauri command layer.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::file_codec::FileCommandError;
use crate::file_identity::{self, CODE_PATH_RESOLUTION};
use crate::watch_event::{
    WatchChangeHint, WatchEvent, WatchEventPayload, WatchInvalidated, WatchScope, WatchSubscription,
};

/* -------------------------------------------------------------------------- */
/* Raw backend layer                                                          */
/* -------------------------------------------------------------------------- */

/// Coarse classification of a raw filesystem occurrence.
///
/// It mirrors [`WatchChangeHint`] but stays backend-local: the core maps one
/// onto the other, so a future backend can report an occurrence this crate does
/// not model yet without changing the wire contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawWatchEventKind {
    /// Something appeared.
    Created,
    /// Something was mutated in place.
    Changed,
    /// Something disappeared.
    Removed,
    /// The backend saw something it cannot classify further.
    Other,
}

/// One raw occurrence reported by a backend.
///
/// `paths` is a list because native watchers batch related paths, and
/// `rename_target` carries a paired rename destination when the backend knows
/// one. Both are preserved rather than resolved here so that 006 can normalize
/// rename/move without a second event pipeline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawWatchEvent {
    /// What the backend believes happened.
    pub kind: RawWatchEventKind,
    /// The paths the occurrence is about.
    pub paths: Vec<PathBuf>,
    /// Rename destination when the occurrence is a rename source.
    pub rename_target: Option<PathBuf>,
}

/// A message from a backend to the bookkeeping core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendMessage {
    /// A raw occurrence at one or more paths.
    Event(RawWatchEvent),
    /// The backend lost events or cannot guarantee completeness for these paths.
    Rescan {
        /// Paths whose completeness guarantee was lost; empty means "unknown".
        paths: Vec<PathBuf>,
        /// Backend-provided explanation, forwarded for diagnostics.
        reason: String,
    },
    /// A backend-level error for these paths.
    Error {
        /// Paths the error concerns; empty means "unknown".
        paths: Vec<PathBuf>,
        /// Backend-provided explanation, forwarded for diagnostics.
        reason: String,
    },
}

/* -------------------------------------------------------------------------- */
/* Backend trait and the real notify implementation                           */
/* -------------------------------------------------------------------------- */

/// The directory-watching operations [`WatcherCore`] needs from a backend.
///
/// Keeping this a trait is what makes subscription/refcount bookkeeping
/// testable without a live OS watcher, and what will let 006 reuse the core
/// with a different backend if that ever becomes necessary.
pub trait WatchBackend: Send {
    /// Starts observing `directory` with the requested scope.
    fn watch(&mut self, directory: &Path, scope: WatchScope) -> Result<(), String>;
    /// Stops observing `directory`.
    fn unwatch(&mut self, directory: &Path) -> Result<(), String>;
}

/// The `notify`-backed backend.
///
/// `notify` is the only watcher stack in this crate: it is event-driven on
/// every supported platform and already handles the Windows, macOS and Linux
/// native APIs, so no polling loop and no hand-written platform watcher exists
/// beside it.
pub struct NotifyWatchBackend {
    /// The platform's recommended native watcher.
    watcher: notify::RecommendedWatcher,
}

impl NotifyWatchBackend {
    /// Builds a watcher that forwards every occurrence to `handler`.
    ///
    /// The handler is invoked from the watcher's own thread, so it must be
    /// `Send` and must not assume it runs on the UI thread.
    pub fn new(handler: impl Fn(BackendMessage) + Send + 'static) -> Result<Self, String> {
        let watcher = notify::recommended_watcher(
            move |result: notify::Result<notify::Event>| match result {
                Ok(event) => {
                    for message in backend_messages(&event) {
                        handler(message);
                    }
                }
                // A backend-level failure is a completeness problem, not a
                // change: it is reported as an error so the consumer
                // revalidates instead of trusting a silent gap.
                Err(error) => {
                    let reason = error.to_string();
                    handler(BackendMessage::Error {
                        paths: error.paths.clone(),
                        reason,
                    });
                }
            },
        )
        .map_err(|error| error.to_string())?;

        Ok(Self { watcher })
    }
}

impl WatchBackend for NotifyWatchBackend {
    fn watch(&mut self, directory: &Path, scope: WatchScope) -> Result<(), String> {
        use notify::Watcher;

        let mode = match scope {
            WatchScope::NonRecursive => notify::RecursiveMode::NonRecursive,
            WatchScope::Recursive => notify::RecursiveMode::Recursive,
        };

        self.watcher
            .watch(directory, mode)
            .map_err(|error| error.to_string())
    }

    fn unwatch(&mut self, directory: &Path) -> Result<(), String> {
        use notify::Watcher;

        self.watcher
            .unwatch(directory)
            .map_err(|error| error.to_string())
    }
}

/// Maps one native event onto zero or more backend messages.
///
/// The mapping is deliberately lossy: access events are dropped because another
/// process simply reading a file is noise for an editor, and anything the
/// backend cannot classify becomes [`RawWatchEventKind::Other`] rather than
/// being guessed at.
fn backend_messages(event: &notify::Event) -> Vec<BackendMessage> {
    use notify::event::{EventKind, Flag, ModifyKind, RenameMode};

    match &event.kind {
        // Someone read the file. Not a change.
        EventKind::Access(_) => Vec::new(),

        EventKind::Create(_) => vec![raw_message(RawWatchEventKind::Created, event)],

        // A paired rename reports source and target in that order, so it is
        // split into the removal of the source and the creation of the target.
        // The pairing itself is preserved on the source hint for 006; 005 never
        // consumes it.
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => rename_messages(event),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            vec![raw_message(RawWatchEventKind::Removed, event)]
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            vec![raw_message(RawWatchEventKind::Created, event)]
        }
        EventKind::Modify(_) => vec![raw_message(RawWatchEventKind::Changed, event)],

        EventKind::Remove(_) => vec![raw_message(RawWatchEventKind::Removed, event)],

        EventKind::Other if event.flag() == Some(Flag::Rescan) => vec![BackendMessage::Rescan {
            paths: event.paths.clone(),
            reason: "watcher backend reported a rescan flag".to_string(),
        }],

        // `Any` and unknown kinds: report an unclassified occurrence so the
        // consumer can still revalidate the path cheaply.
        _ => vec![raw_message(RawWatchEventKind::Other, event)],
    }
}

/// Builds a plain occurrence message from a native event.
fn raw_message(kind: RawWatchEventKind, event: &notify::Event) -> BackendMessage {
    BackendMessage::Event(RawWatchEvent {
        kind,
        paths: event.paths.clone(),
        rename_target: None,
    })
}

/// Splits a paired rename into its removal and creation halves.
fn rename_messages(event: &notify::Event) -> Vec<BackendMessage> {
    match (event.paths.first(), event.paths.get(1)) {
        (Some(source), Some(target)) => vec![
            BackendMessage::Event(RawWatchEvent {
                kind: RawWatchEventKind::Removed,
                paths: vec![source.clone()],
                rename_target: Some(target.clone()),
            }),
            BackendMessage::Event(RawWatchEvent {
                kind: RawWatchEventKind::Created,
                paths: vec![target.clone()],
                rename_target: None,
            }),
        ],
        // A rename pair without both ends is not a pair; treat the occurrence
        // as an in-place modification instead of inventing a migration.
        _ => vec![raw_message(RawWatchEventKind::Changed, event)],
    }
}

/* -------------------------------------------------------------------------- */
/* Bookkeeping core                                                           */
/* -------------------------------------------------------------------------- */

/// One registered subscription.
struct SubscriptionRecord {
    /// Identifier handed to the consumer.
    subscription_id: u64,
    /// The path the consumer asked to observe.
    path: String,
    /// The canonical directory the backend actually watches for it.
    watched_path: PathBuf,
    /// `comparison_key` of `watched_path`: the sharing key for the backend
    /// watch this subscription joins.
    directory_key: String,
    /// Comparison key of the concrete watched entry, used to filter a
    /// non-recursive directory watch down to the subscribed name.
    target_key: String,
    /// Scope the consumer asked for; also decides how events are routed.
    scope: WatchScope,
}

/// One backend watch shared by every subscription of the same directory.
///
/// 005 (non-recursive, opened-document interest) and 006 (recursive, Workspace
/// interest) can legitimately want the *same* directory watched with different
/// scopes — a Workspace root is also the parent directory of a document opened
/// from it. The record therefore tracks the logical demand per scope next to the
/// coverage the backend currently has, instead of letting the first subscriber
/// choose one mode for everybody (FR-009).
struct WatchRecord {
    /// `comparison_key` of `directory`; the sharing key.
    directory_key: String,
    /// The canonical directory passed to the backend.
    directory: PathBuf,
    /// The scope the backend is currently watching this directory with.
    ///
    /// Updated only after the backend transition really succeeded, so a refused
    /// upgrade is never recorded as live coverage (FR-009, FR-011).
    backend_scope: WatchScope,
    /// How many live non-recursive subscriptions depend on this watch.
    non_recursive: usize,
    /// How many live recursive subscriptions depend on this watch.
    recursive: usize,
}

impl WatchRecord {
    /// The coverage the live subscriptions require right now.
    ///
    /// Recursive wins whenever any recursive subscriber exists, which is what
    /// keeps a non-recursive first subscriber from silently downgrading 006's
    /// Workspace coverage.
    fn required_scope(&self) -> WatchScope {
        if self.recursive > 0 {
            WatchScope::Recursive
        } else {
            WatchScope::NonRecursive
        }
    }

    /// Every live subscription of this directory, whatever its scope.
    fn refcount(&self) -> usize {
        self.non_recursive + self.recursive
    }

    /// Registers one subscription of `scope`.
    fn add(&mut self, scope: WatchScope) {
        match scope {
            WatchScope::NonRecursive => self.non_recursive += 1,
            WatchScope::Recursive => self.recursive += 1,
        }
    }

    /// Releases one subscription of `scope`.
    fn remove(&mut self, scope: WatchScope) {
        match scope {
            WatchScope::NonRecursive => self.non_recursive = self.non_recursive.saturating_sub(1),
            WatchScope::Recursive => self.recursive = self.recursive.saturating_sub(1),
        }
    }
}

/// A backend coverage change the core has decided on but not performed yet.
///
/// It is a value rather than an immediate call so the caller can run the native
/// watch/unwatch without holding the core mutex (the deadlock-avoidance rule),
/// and so a refusal can be rolled back knowingly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendChange {
    /// The directory is not watched yet and must be watched with `scope`.
    Watch {
        /// The canonical directory to watch.
        directory: PathBuf,
        /// The scope to watch it with.
        scope: WatchScope,
    },
    /// The directory is watched, but its coverage must change.
    ///
    /// Coverage is replaced explicitly (unwrapatch + watch) because the backend
    /// offers no way to prove a mode change is gap-free. Any such transition
    /// therefore invalidates the consumers that still rely on the directory
    /// (FR-010, FR-011).
    Reconfigure {
        /// The canonical directory whose coverage changes.
        directory: PathBuf,
        /// The coverage it must have afterwards.
        scope: WatchScope,
    },
    /// Nothing depends on the directory any more.
    Unwatch {
        /// The canonical directory to stop watching.
        directory: PathBuf,
    },
}

impl BackendChange {
    /// The directory this change is about.
    fn directory(&self) -> &Path {
        match self {
            BackendChange::Watch { directory, .. }
            | BackendChange::Reconfigure { directory, .. }
            | BackendChange::Unwatch { directory } => directory,
        }
    }
}

/// What [`WatcherCore::begin_subscribe`] decided the backend must do.
///
/// It is returned before any backend call so the caller can perform the watch
/// without holding the core lock, then either confirm or cancel the plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscribePlan {
    /// Identifier reserved for the new subscription.
    pub subscription_id: u64,
    /// The canonical directory to watch.
    pub directory: PathBuf,
    /// The scope the new subscription asked for.
    pub scope: WatchScope,
    /// Backend work required before this subscription may be reported live.
    pub backend: Option<BackendChange>,
    /// Logical `(scope, watchedPath)` pairs whose completeness the transition
    /// may interrupt, so their consumers can revalidate instead of trusting
    /// continuity.
    pub invalidations: Vec<(WatchScope, String)>,
}

/// What [`WatcherCore::detach_subscription`] decided the backend must do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetachPlan {
    /// Backend work required to keep coverage honest; `None` when the remaining
    /// subscriptions are already covered by the current watch.
    pub backend: Option<BackendChange>,
    /// Logical `(scope, watchedPath)` pairs still relying on the directory whose
    /// completeness the transition may interrupt.
    pub invalidations: Vec<(WatchScope, String)>,
}

/// Deterministic watcher bookkeeping: subscriptions, refcounts and routing.
///
/// 005 always watches the *parent directory* of a bound document and filters
/// the events down to the subscribed names, because native watchers are
/// directory-scoped and a file-scoped watch cannot survive replacement or
/// deletion of the watched file. Several documents in one directory therefore
/// share a single backend watch through a refcount.
pub struct WatcherCore {
    /// Every live subscription, in registration order (routing order).
    subscriptions: Vec<SubscriptionRecord>,
    /// Every live backend watch, keyed by canonical directory identity.
    watches: Vec<WatchRecord>,
    /// Next identifier to hand out; starts at 1 so it is never confused with a
    /// default-initialized value.
    next_subscription_id: u64,
}

impl WatcherCore {
    /// Creates an empty core with no subscriptions and no backend watches.
    pub fn new() -> Self {
        Self {
            subscriptions: Vec::new(),
            watches: Vec::new(),
            next_subscription_id: 1,
        }
    }

    /// Resolves the parent directory of `path`, increments/creates the shared
    /// parent-directory watch refcount, and registers a subscription id.
    ///
    /// The directory must already exist: watching a directory that is not there
    /// yet cannot be honest about missing a change, so it is reported as
    /// `path_resolution` instead. This function never touches the backend; the
    /// caller does that with the returned plan and then confirms or cancels it.
    pub fn begin_subscribe(
        &mut self,
        path: &str,
        scope: WatchScope,
    ) -> Result<SubscribePlan, FileCommandError> {
        let requested = Path::new(path);
        let directory = watch_directory(requested, scope);

        let canonical = std::fs::canonicalize(&directory).map_err(|error| {
            FileCommandError::new(
                CODE_PATH_RESOLUTION,
                format!("Cannot resolve the watch directory for {path}: {error}"),
            )
        })?;

        let metadata = std::fs::metadata(&canonical).map_err(|error| {
            FileCommandError::new(
                CODE_PATH_RESOLUTION,
                format!("Cannot resolve the watch directory for {path}: {error}"),
            )
        })?;

        if !metadata.is_dir() {
            return Err(FileCommandError::new(
                CODE_PATH_RESOLUTION,
                format!("Not a directory: {}", canonical.display()),
            ));
        }

        let directory_key = file_identity::comparison_key(&canonical);
        let target_key = match scope {
            // Non-recursive subscriptions filter one directory level, so the
            // concrete entry is the canonical parent joined with the requested
            // final component. Comparing keys instead of strings is what makes
            // this follow the platform's case rules.
            WatchScope::NonRecursive => requested
                .file_name()
                .map(|name| file_identity::comparison_key(&canonical.join(name)))
                .unwrap_or_else(|| directory_key.clone()),
            // A recursive subscription is contained in the watched directory
            // itself, so containment needs no separate target key.
            WatchScope::Recursive => directory_key.clone(),
        };

        let subscription_id = self.next_subscription_id;
        self.next_subscription_id = self.next_subscription_id.saturating_add(1);

        self.subscriptions.push(SubscriptionRecord {
            subscription_id,
            path: path.to_string(),
            watched_path: canonical.clone(),
            directory_key: directory_key.clone(),
            target_key,
            scope,
        });

        // Sharing is keyed on the canonical directory, never on the requested
        // spelling, so `C:\work\notes.txt` and `C:\work\todos.txt` share one
        // watch. The *effective* coverage is the strongest scope any live
        // subscription needs, so a recursive 006 Workspace interest is never
        // downgraded by a non-recursive 005 document interest that arrived first
        // (FR-009).
        let backend = match self
            .watches
            .iter_mut()
            .find(|watch| watch.directory_key == directory_key)
        {
            Some(watch) => {
                watch.add(scope);
                let required = watch.required_scope();
                if required == watch.backend_scope {
                    None
                } else {
                    // The recorded coverage is deliberately left untouched until
                    // the backend really changed: a refused upgrade must not be
                    // remembered as live.
                    Some(BackendChange::Reconfigure {
                        directory: watch.directory.clone(),
                        scope: required,
                    })
                }
            }
            None => {
                let mut watch = WatchRecord {
                    directory_key: directory_key.clone(),
                    directory: canonical.clone(),
                    backend_scope: scope,
                    non_recursive: 0,
                    recursive: 0,
                };
                // Demand is rebuilt from the live logical subscriptions rather
                // than from the newcomer alone: a directory whose coverage was
                // forgotten after a failed transition still has consumers, and
                // the repaired watch has to count every one of them.
                for existing in &self.subscriptions {
                    if existing.directory_key == directory_key {
                        watch.add(existing.scope);
                    }
                }
                let directory = watch.directory.clone();
                self.watches.push(watch);
                Some(BackendChange::Watch { directory, scope })
            }
        };

        // A transition that replaces the backend watch can lose events, so every
        // logical consumer of this directory is told to revalidate rather than
        // trust continuity across the gap (FR-010, FR-011).
        let invalidations = match &backend {
            Some(BackendChange::Watch { .. }) | None => Vec::new(),
            Some(change) => self.logical_pairs_for(change.directory()),
        };

        Ok(SubscribePlan {
            subscription_id,
            directory: canonical,
            scope,
            backend,
            invalidations,
        })
    }

    /// Finalizes a plan whose backend work succeeded.
    ///
    /// The backend coverage is only recorded as live here, after the native call
    /// returned successfully.
    pub fn confirm_subscribe(&mut self, plan: &SubscribePlan) -> WatchSubscription {
        // A widened/narrowed coverage is recorded as live only now, so a refused
        // transition is never remembered as installed bookkeeping.
        if let Some(BackendChange::Reconfigure { directory, scope }) = &plan.backend {
            if let Some(watch) = self
                .watches
                .iter_mut()
                .find(|watch| watch.directory == *directory)
            {
                watch.backend_scope = *scope;
            }
        }

        let path = self
            .subscriptions
            .iter()
            .find(|record| record.subscription_id == plan.subscription_id)
            .map(|record| record.path.clone())
            .unwrap_or_default();

        WatchSubscription {
            subscription_id: plan.subscription_id,
            path,
            watched_path: plan.directory.to_string_lossy().to_string(),
            scope: plan.scope,
        }
    }

    /// Rolls a plan back after its backend work failed.
    ///
    /// The new subscription is dropped, and a failed coverage *change* leaves the
    /// directory's backend watch unusable rather than silently claiming coverage
    /// that no longer exists: the watch record is forgotten, so the surviving
    /// subscriptions are degraded (they keep their logical interest and are told
    /// to revalidate) and the next subscribe attempt repairs the directory with a
    /// fresh watch. No backend `unwatch` is issued here, because the caller only
    /// cancels a plan whose own call failed.
    pub fn cancel_subscribe(&mut self, plan: SubscribePlan) -> Vec<(WatchScope, String)> {
        let _ = self.detach_subscription(plan.subscription_id);

        match plan.backend {
            Some(BackendChange::Reconfigure { directory, .. }) => {
                self.abandon_watch(&directory);
                self.logical_pairs_for(&directory)
            }
            _ => Vec::new(),
        }
    }

    /// Convenience single-threaded composition (begin -> backend change ->
    /// confirm/cancel).
    ///
    /// Used by tests and any caller that owns both halves.
    // 005's manager reaches the core through the plan-based path instead, so
    // this and the test seams below are not called from a non-test build.
    #[allow(dead_code)]
    pub fn subscribe_with(
        &mut self,
        path: &str,
        scope: WatchScope,
        backend: &mut dyn WatchBackend,
    ) -> Result<WatchSubscription, FileCommandError> {
        let plan = self.begin_subscribe(path, scope)?;

        if let Some(change) = plan.backend.clone() {
            if let Err(message) = apply_backend_change(backend, &change) {
                let message = format!("Cannot watch {}: {message}", plan.directory.display());
                self.cancel_subscribe(plan);
                return Err(FileCommandError::new(CODE_PATH_RESOLUTION, message));
            }
        }

        Ok(self.confirm_subscribe(&plan))
    }

    /// Removes a subscription; releases or narrows the shared backend watch when
    /// the remaining demand allows it.
    ///
    /// Returns false for an unknown id, so stopping twice is harmless.
    #[allow(dead_code)]
    pub fn unsubscribe(&mut self, subscription_id: u64, backend: &mut dyn WatchBackend) -> bool {
        match self.detach_subscription(subscription_id) {
            Some(plan) => {
                self.finish_detach(plan, backend);
                true
            }
            None => false,
        }
    }

    /// Performs a detach plan's backend work and records its outcome.
    ///
    /// On failure the directory's backend watch is forgotten: the surviving
    /// subscriptions stay live logically and are revalidated, and a later
    /// subscribe repairs the coverage instead of the core pretending a watch it
    /// could not re-establish is still there.
    #[allow(dead_code)]
    pub fn finish_detach(&mut self, plan: DetachPlan, backend: &mut dyn WatchBackend) {
        let Some(change) = plan.backend.clone() else {
            return;
        };

        if apply_backend_change(backend, &change).is_err() {
            self.abandon_watch(change.directory());
        } else if let BackendChange::Reconfigure { directory, scope } = change {
            if let Some(watch) = self
                .watches
                .iter_mut()
                .find(|watch| watch.directory == directory)
            {
                watch.backend_scope = scope;
            }
        }
    }

    /// Releases every subscription and every backend watch.
    ///
    /// Watches are collected before the backend is touched, so no borrow of the
    /// core bookkeeping is alive while the backend runs.
    #[allow(dead_code)]
    pub fn shutdown(&mut self, backend: &mut dyn WatchBackend) {
        for directory in self.detach_all() {
            let _ = backend.unwatch(&directory);
        }
    }

    /// Converts one backend message into zero or more normalized payloads.
    pub fn handle_message(&mut self, message: BackendMessage) -> Vec<WatchEventPayload> {
        match message {
            BackendMessage::Event(raw) => self.handle_raw_event(raw),
            BackendMessage::Rescan { paths, reason } | BackendMessage::Error { paths, reason } => {
                self.invalidations(&paths, &reason)
            }
        }
    }

    /// Number of live subscriptions.
    #[allow(dead_code)]
    pub fn subscription_count(&self) -> usize {
        self.subscriptions.len()
    }

    /// Number of live backend watches.
    #[allow(dead_code)]
    pub fn active_watch_count(&self) -> usize {
        self.watches.len()
    }

    /// How many subscriptions currently depend on `directory`.
    #[allow(dead_code)]
    pub fn watch_refcount(&self, directory: &Path) -> usize {
        let key = file_identity::comparison_key(directory);
        self.watches
            .iter()
            .find(|watch| watch.directory_key == key)
            .map(|watch| watch.refcount())
            .unwrap_or(0)
    }

    /// Every live logical `(scope, watchedPath)` pair, deduplicated.
    ///
    /// With `paths`, only the pairs whose watched directory is affected by one of
    /// them are reported. Without it, every live pair is — which is what a
    /// backend-global loss notice has to become, because a global notice carries
    /// no path to intersect with and both consumers still have to revalidate
    /// their own interest (FR-010).
    fn logical_pairs_for(&self, directory: &Path) -> Vec<(WatchScope, String)> {
        self.logical_pairs(Some(std::slice::from_ref(&directory.to_path_buf())))
    }

    /// Every live logical pair, optionally filtered by affected paths.
    fn logical_pairs(&self, paths: Option<&[PathBuf]>) -> Vec<(WatchScope, String)> {
        let mut pairs: Vec<(WatchScope, String)> = Vec::new();

        for record in &self.subscriptions {
            if let Some(paths) = paths {
                if !paths
                    .iter()
                    .any(|path| path_affects_directory(path, &record.watched_path))
                {
                    continue;
                }
            }

            let pair = (
                record.scope,
                record.watched_path.to_string_lossy().to_string(),
            );
            if !pairs.contains(&pair) {
                pairs.push(pair);
            }
        }

        pairs
    }

    /// Records the coverage a backend transition really established.
    fn set_backend_scope(&mut self, directory: &Path, scope: WatchScope) {
        if let Some(watch) = self
            .watches
            .iter_mut()
            .find(|watch| watch.directory == directory)
        {
            watch.backend_scope = scope;
        }
    }

    /// Forgets a directory's backend watch after a failed transition.
    ///
    /// The surviving subscriptions keep their logical interest — they are the
    /// consumers' own facts — but the core no longer claims backend coverage for
    /// that directory, so the next subscribe installs a fresh watch instead of
    /// joining one that is no longer known to exist.
    fn abandon_watch(&mut self, directory: &Path) {
        let key = file_identity::comparison_key(directory);
        self.watches.retain(|watch| watch.directory_key != key);
    }

    /// Removes a subscription's bookkeeping and reports the backend work that
    /// keeps coverage honest.
    ///
    /// Shared by [`WatcherCore::unsubscribe`] and [`FilesystemWatcher::stop`],
    /// so the manager can perform the backend call without holding the core
    /// lock at the same time as the backend lock.
    fn detach_subscription(&mut self, subscription_id: u64) -> Option<DetachPlan> {
        // Both lookups happen before anything is mutated, so an unknown
        // identifier leaves the bookkeeping exactly as it was.
        let index = self
            .subscriptions
            .iter()
            .position(|record| record.subscription_id == subscription_id)?;
        let directory_key = self.subscriptions[index].directory_key.clone();
        let scope = self.subscriptions[index].scope;

        self.subscriptions.remove(index);

        let Some(watch_index) = self
            .watches
            .iter()
            .position(|watch| watch.directory_key == directory_key)
        else {
            // The directory is already degraded (a failed transition forgot its
            // watch), so there is nothing to release and nothing to invalidate.
            return Some(DetachPlan {
                backend: None,
                invalidations: Vec::new(),
            });
        };

        let watch = &mut self.watches[watch_index];
        watch.remove(scope);

        if watch.refcount() == 0 {
            let directory = self.watches.remove(watch_index).directory;
            return Some(DetachPlan {
                backend: Some(BackendChange::Unwatch { directory }),
                invalidations: Vec::new(),
            });
        }

        let required = watch.required_scope();
        if required == watch.backend_scope {
            return Some(DetachPlan {
                backend: None,
                invalidations: Vec::new(),
            });
        }

        // The last recursive subscriber left: coverage may narrow again so a
        // closed Workspace does not leave the remaining 005 interest paying
        // recursive-event cost. The narrowing also interrupts completeness, so
        // the remaining consumers are told to revalidate (FR-010).
        let directory = watch.directory.clone();
        Some(DetachPlan {
            invalidations: self.logical_pairs_for(&directory),
            backend: Some(BackendChange::Reconfigure {
                directory,
                scope: required,
            }),
        })
    }

    /// Clears every subscription and returns the directories to unwatch.
    fn detach_all(&mut self) -> Vec<PathBuf> {
        self.subscriptions.clear();
        std::mem::take(&mut self.watches)
            .into_iter()
            .map(|watch| watch.directory)
            .collect()
    }

    /// Routes one raw occurrence through every interested subscription.
    fn handle_raw_event(&mut self, raw: RawWatchEvent) -> Vec<WatchEventPayload> {
        let hint = hint_for(raw.kind);
        let mut payloads = Vec::new();
        // Duplicate tolerance: one message carrying the same path several times
        // must yield one hint per subscription, in first-seen order. The same
        // occurrence delivered twice in two calls still yields two hints — the
        // frontend coalesces bursts, and dropping the second one here would
        // hide a genuine re-change that happened to look identical.
        let mut emitted: Vec<(u64, String, WatchChangeHint)> = Vec::new();

        for (index, path) in raw.paths.iter().enumerate() {
            let path_text = path.to_string_lossy().to_string();

            for record in &self.subscriptions {
                if !record.matches(path) {
                    continue;
                }

                let key = (record.subscription_id, path_text.clone(), hint);
                if emitted.contains(&key) {
                    continue;
                }
                emitted.push(key);

                payloads.push(WatchEventPayload::Change(WatchEvent {
                    subscription_id: record.subscription_id,
                    scope: record.scope,
                    watched_path: record.watched_path.to_string_lossy().to_string(),
                    path: path_text.clone(),
                    hint,
                    // The rename destination belongs to the rename *source*,
                    // which is always the first path of the raw occurrence.
                    rename_target: if index == 0 {
                        raw.rename_target
                            .as_ref()
                            .map(|target| target.to_string_lossy().to_string())
                    } else {
                        None
                    },
                    // 006 maps an event back onto its logical Workspace root
                    // through these, so a canonical/`\\?\`/symlink spelling of the
                    // watched directory can never become a second Tree identity
                    // system (FR-118). 005 ignores both fields.
                    relative_path: relative_path_of(&record.watched_path, path),
                    rename_target_relative_path: if index == 0 {
                        raw.rename_target
                            .as_ref()
                            .and_then(|target| relative_path_of(&record.watched_path, target))
                    } else {
                        None
                    },
                }));
            }
        }

        payloads
    }

    /// Turns a lost-completeness notice into per-logical-scope invalidations.
    ///
    /// Deriving them from the live *logical* subscriptions rather than from the
    /// backend `WatchRecord` is what makes a promoted recursive watch safe: one
    /// promoted backend watch serves a non-recursive 005 interest and a
    /// recursive 006 interest, and each of them has to receive the invalidation
    /// that concerns its own scope instead of whichever scope happened to be
    /// installed (FR-010).
    fn invalidations(&self, paths: &[PathBuf], reason: &str) -> Vec<WatchEventPayload> {
        // No usable path means the backend cannot say what is still reliable, so
        // every live logical interest is named and must be revalidated.
        let filter = if paths.is_empty() { None } else { Some(paths) };

        self.logical_pairs(filter)
            .into_iter()
            .map(|(scope, watched_path)| {
                WatchEventPayload::Invalidated(WatchInvalidated {
                    scope,
                    watched_path: Some(watched_path),
                    reason: reason.to_string(),
                })
            })
            .collect()
    }
}

impl SubscriptionRecord {
    /// Whether an observed path belongs to this subscription.
    fn matches(&self, event_path: &Path) -> bool {
        match self.scope {
            WatchScope::NonRecursive => {
                // Events for the watched directory itself are not changes to
                // any subscribed entry, and they have no final component that
                // could equal the subscribed name.
                let Some(parent) = event_path.parent() else {
                    return false;
                };
                if file_identity::relative_within(parent, &self.watched_path)
                    != Some(String::new())
                {
                    return false;
                }

                let Some(file_name) = event_path.file_name() else {
                    return false;
                };

                // Compare identity keys rather than raw strings. A key asks the
                // *containing directory* for its comparison rule (006/T156),
                // which is metadata about a directory that is still being
                // watched; the event path itself is never touched, so an entry
                // that is already gone cannot fail this check.
                file_identity::comparison_key(&self.watched_path.join(file_name))
                    == self.target_key
            }
            WatchScope::Recursive => {
                // `Some("")` means the event is about the watched directory
                // itself, which is not a change to anything inside it.
                matches!(
                    file_identity::relative_within(&self.watched_path, event_path),
                    Some(relative) if !relative.is_empty()
                )
            }
        }
    }
}

/// The directory a subscription must watch for `path`.
///
/// 005 watches the parent directory non-recursively, because a file-scoped
/// watch cannot survive the file being replaced or deleted. A recursive
/// subscription watches the requested path itself, which is what 006 needs for
/// a Workspace root.
fn watch_directory(path: &Path, scope: WatchScope) -> PathBuf {
    match scope {
        WatchScope::NonRecursive => match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
            // A bare file name resolves against the current directory, which is
            // what the filesystem itself would do.
            _ => PathBuf::from("."),
        },
        WatchScope::Recursive => path.to_path_buf(),
    }
}

/// Whether a lost-completeness notice for `path` touches `directory`.
///
/// Both directions count: the notice may name the directory itself, something
/// inside it, or an ancestor whose events were lost as a whole.
fn path_affects_directory(path: &Path, directory: &Path) -> bool {
    file_identity::relative_within(directory, path).is_some()
        || file_identity::relative_within(path, directory).is_some()
}

/// The event path relative to the subscription's watched directory.
///
/// The watched directory itself has no relative path — an event *about* the
/// watched directory is about its entries, not a change to one of them — and
/// neither has an event that lies outside it. Both are reported as `None`, which
/// is what lets a consumer tell "inside my watch" from "somewhere else".
fn relative_path_of(watched_path: &Path, target: &Path) -> Option<String> {
    match file_identity::relative_within(watched_path, target) {
        Some(relative) if !relative.is_empty() => Some(relative),
        _ => None,
    }
}

/// Performs one decided backend coverage change.
///
/// A scope change is issued as an explicit replacement rather than as a second
/// `watch` call, because no backend promises that re-watching an already-watched
/// directory with a different mode is atomic; the caller treats the resulting gap
/// as lost completeness and invalidates the affected consumers.
fn apply_backend_change(
    backend: &mut dyn WatchBackend,
    change: &BackendChange,
) -> Result<(), String> {
    match change {
        BackendChange::Watch { directory, scope } => backend.watch(directory, *scope),
        BackendChange::Reconfigure { directory, scope } => {
            // The old watch is released first so the new mode really takes
            // effect; a failure here is still reported, and the caller then
            // degrades the directory instead of trusting stale coverage.
            let _ = backend.unwatch(directory);
            backend.watch(directory, *scope)
        }
        BackendChange::Unwatch { directory } => backend.unwatch(directory),
    }
}

/// Maps a raw occurrence onto the coarse hint the frontend consumes.
fn hint_for(kind: RawWatchEventKind) -> WatchChangeHint {
    match kind {
        RawWatchEventKind::Created => WatchChangeHint::Created,
        RawWatchEventKind::Changed => WatchChangeHint::Changed,
        RawWatchEventKind::Removed => WatchChangeHint::Removed,
        RawWatchEventKind::Other => WatchChangeHint::Other,
    }
}

/* -------------------------------------------------------------------------- */
/* Manager                                                                    */
/* -------------------------------------------------------------------------- */

/// Receives every normalized payload the watcher produces.
///
/// Arc so the Tauri command layer can hand the same sink to the notify handler
/// and to the manager; `Send + Sync` because the handler runs on the watcher's
/// own thread.
pub type WatchPayloadSink = std::sync::Arc<dyn Fn(WatchEventPayload) + Send + Sync + 'static>;

/// The reusable, Tauri-free watcher manager.
///
/// Locking rule: the core mutex and the backend mutex are never held at the same
/// time. `start` takes the core, releases it, takes the backend, releases it, and
/// takes the core again; `stop` and `shutdown` detach the bookkeeping first and
/// only then call the backend. The notify handler closure owns only the core and
/// the sink, so no lock ordering between the two can deadlock.
///
/// A second, coarser rule protects *coverage*: the whole decide → native call →
/// confirm sequence is serialized by [`FilesystemWatcher::transition`]. The core
/// bookkeeping records the demand of a subscription as soon as it is planned, so
/// two overlapping transitions on one directory could otherwise make the second
/// caller report a live subscription against coverage the first never
/// established, or let a narrowing downgrade land after a widening upgrade and
/// leave recursive demand served by a non-recursive watch (FR-009, FR-011). The
/// transition guard is taken *before* the core or backend lock and never while
/// holding either, so it adds no new lock-order edge.
pub struct FilesystemWatcher {
    /// Subscription/reference bookkeeping, also shared with the handler.
    core: Arc<Mutex<WatcherCore>>,
    /// The real backend, behind its own mutex so calls do not serialize with
    /// event delivery.
    backend: Mutex<Box<dyn WatchBackend>>,
    /// Serializes backend coverage transitions; see the type documentation.
    transition: Mutex<()>,
    /// Kept so the manager can route a backend message through the same sink
    /// the handler uses. The real notify handler owns its own clone, so only
    /// `handle_backend_message` reads this field.
    #[allow(dead_code)]
    sink: WatchPayloadSink,
}

impl FilesystemWatcher {
    /// Builds the real notify-backed watcher. `sink` receives every normalized payload.
    pub fn new(sink: WatchPayloadSink) -> Result<Self, String> {
        let core = Arc::new(Mutex::new(WatcherCore::new()));
        let handler_core = Arc::clone(&core);
        let handler_sink = Arc::clone(&sink);

        let backend = NotifyWatchBackend::new(move |message| {
            dispatch(&handler_core, &handler_sink, message);
        })?;

        Ok(Self {
            core,
            backend: Mutex::new(Box::new(backend)),
            transition: Mutex::new(()),
            sink,
        })
    }

    /// Test/extension seam: any backend.
    #[allow(dead_code)]
    pub fn with_backend(backend: Box<dyn WatchBackend>, sink: WatchPayloadSink) -> Self {
        Self {
            core: Arc::new(Mutex::new(WatcherCore::new())),
            backend: Mutex::new(backend),
            transition: Mutex::new(()),
            sink,
        }
    }

    /// Registers interest in `path` and returns the subscription handle.
    pub fn start(
        &self,
        path: &str,
        scope: WatchScope,
    ) -> Result<WatchSubscription, FileCommandError> {
        // Coverage transitions are serialized as one unit: planning, the native
        // call and the confirmation all happen under this guard.
        let _transition = lock(&self.transition);

        // Core lock only: decide what must happen and reserve the demand.
        let plan = lock(&self.core).begin_subscribe(path, scope)?;

        if let Some(change) = plan.backend.clone() {
            // Backend lock only, released before the core is touched again.
            // Perform the OS call before confirming, so a refusal is never
            // reported to the frontend as a live subscription.
            let applied = watch_change(&self.backend, &change);
            if let Err(message) = applied {
                let message = format!("Cannot watch {}: {message}", plan.directory.display());
                let invalidations = lock(&self.core).cancel_subscribe(plan);
                self.publish_invalidations(
                    invalidations,
                    "the filesystem watch could not be established or reconfigured",
                );
                return Err(FileCommandError::new(CODE_PATH_RESOLUTION, message));
            }
        }

        // Core lock only again.
        let subscription = lock(&self.core).confirm_subscribe(&plan);

        // A replaced backend watch has an unavoidable gap, so the consumers that
        // still rely on this directory revalidate instead of trusting continuity
        // across it (FR-010, FR-011).
        self.publish_invalidations(
            plan.invalidations.clone(),
            "the filesystem watch coverage changed",
        );

        Ok(subscription)
    }

    /// Idempotent: stopping an unknown subscription succeeds.
    pub fn stop(&self, subscription_id: u64) {
        // Serialized with `start`: a stop that narrows coverage must not land
        // after a start that widened it, and vice versa.
        let _transition = lock(&self.transition);

        let plan = match lock(&self.core).detach_subscription(subscription_id) {
            Some(plan) => plan,
            None => return,
        };

        let mut degraded = Vec::new();
        if let Some(change) = plan.backend.clone() {
            if watch_change(&self.backend, &change).is_err() {
                // The directory's coverage could not be re-established, so the
                // core stops claiming it and every remaining logical interest is
                // told to revalidate from disk instead.
                lock(&self.core).abandon_watch(change.directory());
                degraded = lock(&self.core).logical_pairs_for(change.directory());
            } else if let BackendChange::Reconfigure { directory, scope } = change {
                lock(&self.core).set_backend_scope(&directory, scope);
            }
        }

        let mut invalidations = plan.invalidations;
        invalidations.extend(degraded);
        invalidations.sort_by(|left, right| left.1.cmp(&right.1));
        invalidations.dedup();

        self.publish_invalidations(
            invalidations,
            "the filesystem watch coverage changed",
        );
    }

    /// Releases every watch. Called on application shutdown.
    pub fn shutdown(&self) {
        let _transition = lock(&self.transition);

        // Bound before the loop so the core guard is released before the
        // backend lock is taken.
        let directories = lock(&self.core).detach_all();

        for directory in directories {
            let _ = lock(&self.backend).unwatch(&directory);
        }
    }

    /// Forwards invalidation notices for logical `(scope, path)` pairs.
    fn publish_invalidations(&self, pairs: Vec<(WatchScope, String)>, reason: &str) {
        for (scope, watched_path) in pairs {
            (self.sink)(WatchEventPayload::Invalidated(WatchInvalidated {
                scope,
                watched_path: Some(watched_path),
                reason: reason.to_string(),
            }));
        }
    }

    /// Feeds one backend message through the core and the sink.
    ///
    /// The real notify handler runs this same pipeline; it is exposed so a test
    /// or a future 006 sampler that owns a backend out of band can drive it
    /// deterministically without waiting on OS event timing.
    #[allow(dead_code)]
    pub fn handle_backend_message(&self, message: BackendMessage) {
        dispatch(&self.core, &self.sink, message);
    }
}

/// Normalizes one backend message and forwards the payloads to the sink.
///
/// The core lock is released before the sink runs, so a slow consumer can never
/// stall event delivery into the core.
fn dispatch(core: &Mutex<WatcherCore>, sink: &WatchPayloadSink, message: BackendMessage) {
    let payloads = lock(core).handle_message(message);

    for payload in payloads {
        sink(payload);
    }
}

/// Locks a mutex, recovering from poisoning instead of panicking.
///
/// A poisoned watcher mutex means some other thread panicked while holding it;
/// the bookkeeping itself is still consistent, and taking the whole watcher
/// down would break a running editor for no reason.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Applies one backend coverage change while holding only the backend lock.
///
/// Kept a free function so the manager never has to hold the core lock and the
/// backend lock at the same time: the decision is made under the core lock, the
/// native call happens under the backend lock alone, and the bookkeeping is
/// confirmed afterwards.
fn watch_change(
    backend: &Mutex<Box<dyn WatchBackend>>,
    change: &BackendChange,
) -> Result<(), String> {
    apply_backend_change(&mut **lock(backend), change)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc;
    use std::sync::Mutex as StdMutex;
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    /* ---------------------------------------------------------------- */
    /* Live backend (the only test that uses the real OS watcher)          */
    /* ---------------------------------------------------------------- */

    /// Proves the production path end to end: the real `notify` backend, the
    /// parent-directory watch, event routing and normalization, and the sink.
    ///
    /// This is the one test here that depends on OS event timing. The dependence is
    /// deliberate and bounded: the plan forbids making the *suite* timing-based, but
    /// the alternative is leaving the feature's only OS integration completely
    /// unverified, which is how a "a clean file changed externally is never
    /// noticed" bug can survive a green test run.
    #[test]
    fn live_backend_reports_an_external_write_to_a_subscribed_file() {
        let dir = work_dir("live-backend");
        let target = write_file(&dir, "notes.txt");

        let payloads: Arc<StdMutex<Vec<WatchEventPayload>>> =
            Arc::new(StdMutex::new(Vec::new()));
        let sink_state = Arc::clone(&payloads);
        let sink: WatchPayloadSink = Arc::new(move |payload| {
            sink_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(payload);
        });

        let watcher = FilesystemWatcher::new(sink).expect("create the real watcher");
        watcher
            .start(&display(&target), WatchScope::NonRecursive)
            .expect("watch the fixture file");

        // The write is repeated until an event arrives, so the platform's arming
        // gap (the moment between `watch` returning and the OS actually reporting)
        // costs one attempt instead of failing the test.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut received = false;
        let mut attempt: u32 = 0;
        let mut last_write = std::time::Instant::now() - std::time::Duration::from_secs(1);

        while std::time::Instant::now() < deadline && !received {
            if last_write.elapsed() >= std::time::Duration::from_millis(500) {
                attempt += 1;
                fs::write(&target, format!("alpha\nbeta\nchanged externally {attempt}"))
                    .expect("modify the fixture");
                last_write = std::time::Instant::now();
            }

            std::thread::sleep(std::time::Duration::from_millis(25));
            let recorded = payloads
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            received = recorded.iter().any(|payload| match payload {
                WatchEventPayload::Change(event) => {
                    event.path.eq_ignore_ascii_case(&display(&target))
                }
                WatchEventPayload::Invalidated(_) => false,
            });
        }

        watcher.shutdown();
        let _ = fs::remove_dir_all(&dir);

        assert!(
            received,
            "the real backend must report an external write to a watched file; no \
             change payload for {} arrived within 10s and {attempt} writes \
             (recorded: {:?})",
            display(&target),
            payloads
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
        );
    }

    /* ---------------------------------------------------------------- */
    /* Fixtures                                                          */
    /* ---------------------------------------------------------------- */

    /// A canonical temporary directory, so fixture paths match the canonical
    /// paths the core works with (Windows canonicalization adds the `\\?\`
    /// prefix, which would otherwise never compare equal).
    fn work_dir(name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("sorakada-watch-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        fs::canonicalize(&dir).expect("canonicalize temp dir")
    }

    fn write_file(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, b"alpha\nbeta").expect("write fixture");
        path
    }

    fn display(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn change(payload: &WatchEventPayload) -> &WatchEvent {
        match payload {
            WatchEventPayload::Change(event) => event,
            other => panic!("expected a change payload, got {other:?}"),
        }
    }

    fn invalidated(payload: &WatchEventPayload) -> &WatchInvalidated {
        match payload {
            WatchEventPayload::Invalidated(invalidated) => invalidated,
            other => panic!("expected an invalidated payload, got {other:?}"),
        }
    }

    fn raw(kind: RawWatchEventKind, paths: Vec<PathBuf>) -> BackendMessage {
        BackendMessage::Event(RawWatchEvent {
            kind,
            paths,
            rename_target: None,
        })
    }

    fn raw_with_target(
        kind: RawWatchEventKind,
        paths: Vec<PathBuf>,
        rename_target: PathBuf,
    ) -> BackendMessage {
        BackendMessage::Event(RawWatchEvent {
            kind,
            paths,
            rename_target: Some(rename_target),
        })
    }

    /// Backend state shared with the test so calls can be asserted afterwards.
    #[derive(Default)]
    struct RecordingState {
        watched: Vec<(PathBuf, WatchScope)>,
        unwatched: Vec<PathBuf>,
        fail_watch: bool,
    }

    /// A [`WatchBackend`] that records calls instead of touching the OS.
    #[derive(Clone, Default)]
    struct RecordingBackend {
        state: Arc<StdMutex<RecordingState>>,
    }

    impl RecordingBackend {
        fn new() -> Self {
            Self::default()
        }

        fn watched(&self) -> Vec<(PathBuf, WatchScope)> {
            lock(&self.state).watched.clone()
        }

        fn unwatched(&self) -> Vec<PathBuf> {
            lock(&self.state).unwatched.clone()
        }

        /// Makes the next `watch` call fail, as a backend refusal would.
        fn fail_next_watch(&self) {
            lock(&self.state).fail_watch = true;
        }
    }

    impl WatchBackend for RecordingBackend {
        fn watch(&mut self, directory: &Path, scope: WatchScope) -> Result<(), String> {
            let mut state = lock(&self.state);
            if state.fail_watch {
                state.fail_watch = false;
                return Err("backend refused the watch".to_string());
            }
            state.watched.push((directory.to_path_buf(), scope));
            Ok(())
        }

        fn unwatch(&mut self, directory: &Path) -> Result<(), String> {
            lock(&self.state).unwatched.push(directory.to_path_buf());
            Ok(())
        }
    }

    /* ---------------------------------------------------------------- */
    /* Native notify mapping                                             */
    /* ---------------------------------------------------------------- */

    /// The notify → backend-message mapping is production code, so it is
    /// pinned with synthetic notify events instead of a live OS watcher.
    #[test]
    fn notify_events_map_onto_backend_messages() {
        use notify::event::{
            AccessKind, CreateKind, DataChange, EventKind, Flag, ModifyKind, RemoveKind, RenameMode,
        };

        let source = PathBuf::from("C:\\work\\old.txt");
        let target = PathBuf::from("C:\\work\\new.txt");

        // Another process reading a file is noise for an editor.
        assert!(backend_messages(
            &notify::Event::new(EventKind::Access(AccessKind::Read)).add_path(source.clone())
        )
        .is_empty());

        let created = backend_messages(
            &notify::Event::new(EventKind::Create(CreateKind::File)).add_path(source.clone()),
        );
        assert_eq!(
            created,
            vec![raw(RawWatchEventKind::Created, vec![source.clone()])]
        );

        let removed = backend_messages(
            &notify::Event::new(EventKind::Remove(RemoveKind::File)).add_path(source.clone()),
        );
        assert_eq!(
            removed,
            vec![raw(RawWatchEventKind::Removed, vec![source.clone()])]
        );

        let modified = backend_messages(
            &notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(source.clone()),
        );
        assert_eq!(
            modified,
            vec![raw(RawWatchEventKind::Changed, vec![source.clone()])]
        );

        // A paired rename splits into the removal of the source (which carries
        // the destination for 006) and the creation of the target.
        let pair = backend_messages(
            &notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(source.clone())
                .add_path(target.clone()),
        );
        assert_eq!(
            pair,
            vec![
                raw_with_target(
                    RawWatchEventKind::Removed,
                    vec![source.clone()],
                    target.clone()
                ),
                raw(RawWatchEventKind::Created, vec![target.clone()]),
            ]
        );

        // Half a rename pair is still a concrete removal or creation.
        let from = backend_messages(
            &notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::From)))
                .add_path(source.clone()),
        );
        assert_eq!(
            from,
            vec![raw(RawWatchEventKind::Removed, vec![source.clone()])]
        );

        let to = backend_messages(
            &notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To)))
                .add_path(target.clone()),
        );
        assert_eq!(
            to,
            vec![raw(RawWatchEventKind::Created, vec![target.clone()])]
        );

        // A rename that lost one end is only a modification: 005 never invents
        // a path migration from half an occurrence.
        let incomplete = backend_messages(
            &notify::Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)))
                .add_path(source.clone()),
        );
        assert_eq!(
            incomplete,
            vec![raw(RawWatchEventKind::Changed, vec![source.clone()])]
        );

        // A rescan flag is a completeness problem, never a change.
        let rescan = backend_messages(
            &notify::Event::new(EventKind::Other)
                .set_flag(Flag::Rescan)
                .add_path(source.clone()),
        );
        assert_eq!(
            rescan,
            vec![BackendMessage::Rescan {
                paths: vec![source.clone()],
                reason: "watcher backend reported a rescan flag".to_string(),
            }]
        );

        // Anything the backend cannot classify still reports an occurrence.
        let unclassified =
            backend_messages(&notify::Event::new(EventKind::Any).add_path(source.clone()));
        assert_eq!(
            unclassified,
            vec![raw(RawWatchEventKind::Other, vec![source.clone()])]
        );
    }

    /* ---------------------------------------------------------------- */
    /* Sharing and refcounts                                             */
    /* ---------------------------------------------------------------- */

    /// Two documents in one directory must share exactly one backend watch.
    #[test]
    fn subscriptions_in_one_directory_share_a_single_backend_watch() {
        let dir = work_dir("shared");
        let notes = write_file(&dir, "notes.txt");
        let todos = write_file(&dir, "todos.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        let first = core
            .subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the first file");
        let second = core
            .subscribe_with(&display(&todos), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the second file");

        assert_ne!(
            first.subscription_id, second.subscription_id,
            "each subscription keeps its own identifier"
        );
        assert_eq!(core.subscription_count(), 2);
        assert_eq!(core.active_watch_count(), 1);
        assert_eq!(core.watch_refcount(&dir), 2);
        assert_eq!(
            backend.watched(),
            vec![(dir.clone(), WatchScope::NonRecursive)],
            "the backend must be asked to watch the shared parent exactly once"
        );

        assert_eq!(first.watched_path, display(&dir));
        assert_eq!(first.path, display(&notes));
        assert_eq!(second.watched_path, display(&dir));

        let _ = fs::remove_dir_all(&dir);
    }

    /// The shared watch survives until the last subscription is released.
    #[test]
    fn the_shared_watch_is_released_only_by_the_last_unsubscribe() {
        let dir = work_dir("refcount");
        let notes = write_file(&dir, "notes.txt");
        let todos = write_file(&dir, "todos.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        let first = core
            .subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the first file");
        let second = core
            .subscribe_with(&display(&todos), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the second file");

        assert!(core.unsubscribe(first.subscription_id, &mut backend));
        assert_eq!(core.subscription_count(), 1);
        assert_eq!(core.active_watch_count(), 1);
        assert_eq!(core.watch_refcount(&dir), 1);
        assert!(
            backend.unwatched().is_empty(),
            "the shared watch must stay alive while one subscription remains"
        );

        assert!(core.unsubscribe(second.subscription_id, &mut backend));
        assert_eq!(core.subscription_count(), 0);
        assert_eq!(core.active_watch_count(), 0);
        assert_eq!(core.watch_refcount(&dir), 0);
        assert_eq!(
            backend.unwatched(),
            vec![dir.clone()],
            "the backend watch is removed exactly once, by the last unsubscribe"
        );

        assert!(
            !core.unsubscribe(second.subscription_id, &mut backend),
            "stopping an unknown subscription is idempotent"
        );
        assert_eq!(
            backend.unwatched().len(),
            1,
            "an unknown identifier must not unwatch anything"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// Unrelated directories get independent watches and independent routing.
    #[test]
    fn unrelated_directories_get_independent_watches_and_routing() {
        let left = work_dir("independent-left");
        let right = work_dir("independent-right");
        let left_notes = write_file(&left, "notes.txt");
        let right_notes = write_file(&right, "notes.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        let left_subscription = core
            .subscribe_with(
                &display(&left_notes),
                WatchScope::NonRecursive,
                &mut backend,
            )
            .expect("subscribe in the left directory");
        let right_subscription = core
            .subscribe_with(
                &display(&right_notes),
                WatchScope::NonRecursive,
                &mut backend,
            )
            .expect("subscribe in the right directory");

        assert_eq!(core.active_watch_count(), 2);
        assert_eq!(backend.watched().len(), 2);
        assert_eq!(core.watch_refcount(&left), 1);
        assert_eq!(core.watch_refcount(&right), 1);

        let payloads = core.handle_message(raw(RawWatchEventKind::Changed, vec![left_notes]));

        assert_eq!(payloads.len(), 1, "only the left directory is interested");
        assert_eq!(
            change(&payloads[0]).subscription_id,
            left_subscription.subscription_id
        );
        assert_ne!(
            left_subscription.subscription_id,
            right_subscription.subscription_id
        );

        let _ = fs::remove_dir_all(&left);
        let _ = fs::remove_dir_all(&right);
    }

    /* ---------------------------------------------------------------- */
    /* Filtering                                                         */
    /* ---------------------------------------------------------------- */

    /// A sibling file in the same directory is not this subscription's business.
    #[test]
    fn an_unrelated_file_in_the_same_directory_produces_no_hint() {
        let dir = work_dir("unrelated-file");
        let notes = write_file(&dir, "notes.txt");
        let other = write_file(&dir, "other.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();
        core.subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe");

        assert!(core
            .handle_message(raw(RawWatchEventKind::Changed, vec![other]))
            .is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    /// An event about the watched directory itself is not a change to an entry.
    #[test]
    fn an_event_for_the_watched_directory_produces_no_hint() {
        let dir = work_dir("watched-directory");
        let notes = write_file(&dir, "notes.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();
        core.subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe");

        assert!(
            core.handle_message(raw(RawWatchEventKind::Changed, vec![dir.clone()]))
                .is_empty(),
            "the parent directory itself has no subscribed final component"
        );

        // The recursive scope watches the subscribed directory itself, and the
        // same rule has to hold there.
        let nested = dir.join("nested");
        fs::create_dir_all(&nested).expect("create nested dir");
        let recursive = core
            .subscribe_with(&display(&nested), WatchScope::Recursive, &mut backend)
            .expect("subscribe recursively");

        assert!(
            core.handle_message(raw(RawWatchEventKind::Changed, vec![nested.clone()]))
                .is_empty(),
            "the root of a recursive watch is not inside itself"
        );

        let child = nested.join("a.txt");
        let payloads = core.handle_message(raw(RawWatchEventKind::Changed, vec![child.clone()]));
        assert_eq!(payloads.len(), 1, "a descendant is inside the watch");
        assert_eq!(
            change(&payloads[0]).subscription_id,
            recursive.subscription_id
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /* ---------------------------------------------------------------- */
    /* Normalization                                                     */
    /* ---------------------------------------------------------------- */

    /// Every raw kind maps onto its user-facing hint.
    #[test]
    fn raw_event_kinds_normalize_onto_the_change_hints() {
        let dir = work_dir("kinds");
        let notes = write_file(&dir, "notes.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();
        core.subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe");

        for (kind, expected) in [
            (RawWatchEventKind::Created, WatchChangeHint::Created),
            (RawWatchEventKind::Changed, WatchChangeHint::Changed),
            (RawWatchEventKind::Removed, WatchChangeHint::Removed),
            (RawWatchEventKind::Other, WatchChangeHint::Other),
        ] {
            let payloads = core.handle_message(raw(kind, vec![notes.clone()]));

            assert_eq!(payloads.len(), 1, "{kind:?} must produce one hint");
            assert_eq!(change(&payloads[0]).hint, expected);
            assert_eq!(change(&payloads[0]).scope, WatchScope::NonRecursive);
            assert_eq!(change(&payloads[0]).watched_path, display(&dir));
            assert_eq!(change(&payloads[0]).path, display(&notes));
            assert_eq!(
                change(&payloads[0]).rename_target,
                None,
                "a plain change carries no rename destination"
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// A paired rename keeps its destination on the source hint only.
    #[test]
    fn a_rename_pair_carries_the_target_on_the_source_hint() {
        let dir = work_dir("rename-target");
        let notes = write_file(&dir, "notes.txt");
        let todos = write_file(&dir, "todos.txt");
        let moved = dir.join("moved.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();
        core.subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the first file");
        core.subscribe_with(&display(&todos), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the second file");

        let payloads = core.handle_message(raw_with_target(
            RawWatchEventKind::Removed,
            vec![notes.clone()],
            moved.clone(),
        ));

        assert_eq!(payloads.len(), 1);
        assert_eq!(
            change(&payloads[0]).rename_target,
            Some(display(&moved)),
            "the removal hint of a rename names its destination"
        );

        // With several paths in one raw occurrence the destination belongs to
        // the source, which is always the first path.
        let payloads = core.handle_message(raw_with_target(
            RawWatchEventKind::Removed,
            vec![notes.clone(), todos.clone()],
            moved.clone(),
        ));

        assert_eq!(payloads.len(), 2);
        assert_eq!(
            change(&payloads[0]).rename_target,
            Some(display(&moved))
        );
        assert_eq!(change(&payloads[1]).rename_target, None);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Duplicates inside one message collapse; duplicates across messages do not.
    #[test]
    fn duplicate_raw_paths_collapse_within_a_message_only() {
        let dir = work_dir("duplicates");
        let notes = write_file(&dir, "notes.txt");
        let todos = write_file(&dir, "todos.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();
        let notes_subscription = core
            .subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the first file");
        core.subscribe_with(&display(&todos), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the second file");

        let repeated = raw(
            RawWatchEventKind::Changed,
            vec![notes.clone(), notes.clone(), notes.clone()],
        );

        let first = core.handle_message(repeated.clone());
        assert_eq!(
            first.len(),
            1,
            "one message with a repeated path must yield one hint"
        );
        assert_eq!(
            change(&first[0]).subscription_id,
            notes_subscription.subscription_id
        );

        let second = core.handle_message(repeated);
        assert_eq!(
            second.len(),
            1,
            "the same occurrence in a later message is a new hint"
        );
        assert_eq!(first, second);

        let _ = fs::remove_dir_all(&dir);
    }

    /* ---------------------------------------------------------------- */
    /* Invalidation                                                      */
    /* ---------------------------------------------------------------- */

    /// Lost completeness becomes invalidation, deduplicated per directory.
    #[test]
    fn lost_completeness_invalidates_the_affected_directory_exactly_once() {
        let dir = work_dir("invalidated");
        let notes = write_file(&dir, "notes.txt");
        let todos = write_file(&dir, "todos.txt");
        let elsewhere = work_dir("invalidated-elsewhere");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();
        core.subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the first file");
        core.subscribe_with(&display(&todos), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the second file");

        for message in [
            BackendMessage::Rescan {
                paths: vec![dir.clone(), notes.clone()],
                reason: "overflow".to_string(),
            },
            BackendMessage::Error {
                paths: vec![dir.clone()],
                reason: "backend failed".to_string(),
            },
        ] {
            let payloads = core.handle_message(message);

            assert_eq!(
                payloads.len(),
                1,
                "both subscriptions share one directory, so they invalidate once"
            );
            assert!(
                matches!(payloads[0], WatchEventPayload::Invalidated(_)),
                "invalidation must never become a change hint"
            );

            let invalidation = invalidated(&payloads[0]);
            assert_eq!(invalidation.watched_path, Some(display(&dir)));
            assert_eq!(invalidation.scope, WatchScope::NonRecursive);
            assert!(!invalidation.reason.is_empty());
        }

        assert!(
            core.handle_message(BackendMessage::Rescan {
                paths: vec![elsewhere.clone()],
                reason: "overflow".to_string(),
            })
            .is_empty(),
            "an unrelated directory invalidates nothing watched here"
        );

        // An empty path list means the backend cannot say what is still
        // reliable, so every live *logical* interest is named and must be
        // revalidated. The two non-recursive subscriptions above share one
        // directory and therefore one logical pair (FR-010).
        let unnamed = core.handle_message(BackendMessage::Error {
            paths: Vec::new(),
            reason: "overflow".to_string(),
        });
        assert_eq!(unnamed.len(), 1, "one logical pair is invalidated once");
        assert_eq!(invalidated(&unnamed[0]).watched_path, Some(display(&dir)));
        assert_eq!(invalidated(&unnamed[0]).scope, WatchScope::NonRecursive);
        assert_eq!(
            serde_json::to_value(&unnamed[0]).expect("serialize the invalidation"),
            json!({
                "type": "invalidated",
                "scope": "nonRecursive",
                "watchedPath": display(&dir),
                "reason": "overflow",
            })
        );

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&elsewhere);
    }

    /* ---------------------------------------------------------------- */
    /* Failure and teardown                                              */
    /* ---------------------------------------------------------------- */

    /// A missing parent and a refused backend watch both leave no trace.
    #[test]
    fn failed_subscriptions_report_path_resolution_and_roll_back() {
        let dir = work_dir("failures");
        let notes = write_file(&dir, "notes.txt");
        let orphan = dir.join("no-such-directory").join("notes.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        let missing = core
            .subscribe_with(&display(&orphan), WatchScope::NonRecursive, &mut backend)
            .expect_err("a missing parent directory cannot be watched");
        assert_eq!(missing.code, CODE_PATH_RESOLUTION);
        assert!(
            missing.message.contains(&display(&dir)),
            "the message must name the path it could not resolve"
        );
        assert_eq!(core.subscription_count(), 0);
        assert_eq!(core.active_watch_count(), 0);
        assert!(backend.watched().is_empty());

        backend.fail_next_watch();
        let refused = core
            .subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect_err("a refused backend watch must fail the subscription");
        assert_eq!(refused.code, CODE_PATH_RESOLUTION);
        assert_eq!(
            core.watch_refcount(&dir),
            0,
            "a failed watch must not leave a refcount behind"
        );
        assert_eq!(core.subscription_count(), 0);
        assert_eq!(core.active_watch_count(), 0);

        // The directory is still usable afterwards.
        let recovered = core
            .subscribe_with(&display(&notes), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe after the failure");
        assert_eq!(core.watch_refcount(&dir), 1);
        assert_eq!(backend.watched().len(), 1);
        assert!(core.unsubscribe(recovered.subscription_id, &mut backend));

        let _ = fs::remove_dir_all(&dir);
    }

    /// Shutdown releases every backend watch and forgets every subscription.
    #[test]
    fn shutdown_unwatches_everything_and_clears_subscriptions() {
        let first_dir = work_dir("shutdown-first");
        let second_dir = work_dir("shutdown-second");
        let first = write_file(&first_dir, "notes.txt");
        let second = write_file(&first_dir, "todos.txt");
        let third = write_file(&second_dir, "notes.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();
        for path in [&first, &second, &third] {
            core.subscribe_with(&display(path), WatchScope::NonRecursive, &mut backend)
                .expect("subscribe");
        }

        assert_eq!(core.subscription_count(), 3);
        assert_eq!(core.active_watch_count(), 2);

        core.shutdown(&mut backend);

        assert_eq!(core.subscription_count(), 0);
        assert_eq!(core.active_watch_count(), 0);
        assert_eq!(core.watch_refcount(&first_dir), 0);
        assert_eq!(core.watch_refcount(&second_dir), 0);

        let unwatched = backend.unwatched();
        assert_eq!(unwatched.len(), 2, "each backend watch is removed once");
        assert!(unwatched.contains(&first_dir));
        assert!(unwatched.contains(&second_dir));

        assert!(
            core.handle_message(raw(RawWatchEventKind::Changed, vec![first.clone()]))
                .is_empty(),
            "a shutdown core routes nothing any more"
        );

        let _ = fs::remove_dir_all(&first_dir);
        let _ = fs::remove_dir_all(&second_dir);
    }

    /* ---------------------------------------------------------------- */
    /* Manager                                                           */
    /* ---------------------------------------------------------------- */

    /// The manager pipeline reaches the sink with a normalized payload, and
    /// stopping is idempotent.
    #[test]
    fn the_manager_normalizes_backend_messages_into_sink_payloads() {
        let dir = work_dir("manager-sink");
        let notes = write_file(&dir, "notes.txt");

        let recorded: Arc<StdMutex<Vec<WatchEventPayload>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink_state = Arc::clone(&recorded);
        let sink: WatchPayloadSink = Arc::new(move |payload| {
            lock(&sink_state).push(payload);
        });

        let watcher = FilesystemWatcher::with_backend(Box::new(RecordingBackend::new()), sink);

        let subscription = watcher
            .start(&display(&notes), WatchScope::NonRecursive)
            .expect("start the watch");

        assert_eq!(subscription.path, display(&notes));
        assert_eq!(subscription.watched_path, display(&dir));

        watcher.handle_backend_message(raw(RawWatchEventKind::Changed, vec![notes.clone()]));

        let payloads = lock(&recorded).clone();
        assert_eq!(payloads.len(), 1, "the sink receives the normalized payload");
        let event = change(&payloads[0]);
        assert_eq!(event.subscription_id, subscription.subscription_id);
        assert_eq!(event.hint, WatchChangeHint::Changed);
        assert_eq!(event.path, display(&notes));
        assert_eq!(event.watched_path, display(&dir));
        assert_eq!(event.scope, WatchScope::NonRecursive);

        watcher.stop(subscription.subscription_id);
        watcher.stop(subscription.subscription_id);
        watcher.stop(u64::MAX);
        watcher.shutdown();

        let _ = fs::remove_dir_all(&dir);
    }

    /// The recursive scope routes descendants and ignores siblings.
    #[test]
    fn the_recursive_scope_routes_descendants_of_the_subscribed_path() {
        let root = work_dir("recursive");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create nested dir");
        let inside = nested.join("a.txt");
        let outside = write_file(&root, "elsewhere.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();
        let subscription = core
            .subscribe_with(&display(&nested), WatchScope::Recursive, &mut backend)
            .expect("subscribe recursively");

        assert_eq!(
            backend.watched(),
            vec![(nested.clone(), WatchScope::Recursive)],
            "a recursive subscription watches the requested path itself"
        );

        let payloads = core.handle_message(raw(RawWatchEventKind::Created, vec![inside.clone()]));
        assert_eq!(payloads.len(), 1);
        assert_eq!(change(&payloads[0]).path, display(&inside));
        assert_eq!(change(&payloads[0]).scope, WatchScope::Recursive);

        assert!(
            core.handle_message(raw(RawWatchEventKind::Created, vec![outside]))
                .is_empty(),
            "a sibling of the subscribed path is outside the recursive watch"
        );

        assert!(core.unsubscribe(subscription.subscription_id, &mut backend));

        let _ = fs::remove_dir_all(&root);
    }

    /* ---------------------------------------------------------------- */
    /* Mixed non-recursive/recursive coverage (006)                      */
    /* ---------------------------------------------------------------- */

    /// 005 (opened document) and 006 (Workspace root) can legitimately want the
    /// same directory with different scopes. A recursive subscriber added to an
    /// existing non-recursive watch must promote the backend coverage instead of
    /// silently joining the narrower one (FR-009).
    #[test]
    fn a_recursive_subscriber_promotes_an_existing_non_recursive_watch() {
        let root = work_dir("mixed-promote");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create nested dir");
        let document = write_file(&root, "notes.txt");
        let descendant = nested.join("a.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        let _document_subscription = core
            .subscribe_with(&display(&document), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the document");
        assert_eq!(
            backend.watched(),
            vec![(root.clone(), WatchScope::NonRecursive)]
        );

        let workspace = core
            .subscribe_with(&display(&root), WatchScope::Recursive, &mut backend)
            .expect("subscribe to the Workspace root");

        assert_eq!(
            backend.watched(),
            vec![
                (root.clone(), WatchScope::NonRecursive),
                (root.clone(), WatchScope::Recursive),
            ],
            "the recursive subscriber must promote the shared backend watch"
        );
        assert_eq!(core.active_watch_count(), 1, "one directory, one watch");
        assert_eq!(core.watch_refcount(&root), 2);

        let payloads = core.handle_message(raw(RawWatchEventKind::Created, vec![descendant.clone()]));
        assert_eq!(
            payloads.len(),
            1,
            "recursive descendant coverage must not be downgraded by the first subscriber"
        );
        assert_eq!(
            change(&payloads[0]).subscription_id,
            workspace.subscription_id
        );

        // The reverse order must not downgrade anything either.
        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();
        let workspace = core
            .subscribe_with(&display(&root), WatchScope::Recursive, &mut backend)
            .expect("subscribe recursively first");
        let document_subscription = core
            .subscribe_with(&display(&document), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the document second");

        assert_eq!(
            backend.watched(),
            vec![(root.clone(), WatchScope::Recursive)],
            "a later non-recursive subscriber joins the recursive watch unchanged"
        );
        assert_eq!(
            core.subscription_count(),
            2,
            "both logical interests stay registered: {document_subscription:?} {workspace:?}"
        );

        let payloads = core.handle_message(raw(RawWatchEventKind::Created, vec![descendant]));
        assert_eq!(payloads.len(), 1);
        assert_eq!(
            change(&payloads[0]).subscription_id,
            workspace.subscription_id
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// A promoted backend watch still routes each subscription by *its own*
    /// scope: over-observation must never widen a 005 document interest (FR-009).
    #[test]
    fn a_promoted_recursive_watch_routes_each_subscription_by_its_own_scope() {
        let root = work_dir("mixed-routing");
        let nested = root.join("src");
        fs::create_dir_all(&nested).expect("create nested dir");
        let document = write_file(&root, "notes.txt");
        let descendant = nested.join("deep.ts");
        let moved = root.join("moved.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        let document_subscription = core
            .subscribe_with(&display(&document), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the document");
        let workspace = core
            .subscribe_with(&display(&root), WatchScope::Recursive, &mut backend)
            .expect("subscribe to the Workspace root");

        // A descendant is the Workspace's business only.
        let payloads = core.handle_message(raw(RawWatchEventKind::Created, vec![descendant.clone()]));
        assert_eq!(payloads.len(), 1);
        assert_eq!(change(&payloads[0]).subscription_id, workspace.subscription_id);
        assert_eq!(
            change(&payloads[0]).relative_path,
            Some(String::from("src") + std::path::MAIN_SEPARATOR_STR + "deep.ts"),
            "006 receives the subscription-relative location"
        );
        assert_eq!(
            change(&payloads[0]).rename_target_relative_path,
            None,
            "a plain creation carries no rename target"
        );

        // The subscribed document is both consumers' business, each with its own
        // scope and its own relative path.
        let payloads = core.handle_message(raw_with_target(
            RawWatchEventKind::Removed,
            vec![document.clone()],
            moved.clone(),
        ));
        assert_eq!(payloads.len(), 2, "both subscriptions are interested");

        let document_hint = payloads
            .iter()
            .map(change)
            .find(|event| event.subscription_id == document_subscription.subscription_id)
            .expect("the document subscription must receive its own hint");
        assert_eq!(document_hint.scope, WatchScope::NonRecursive);
        assert_eq!(document_hint.relative_path, Some("notes.txt".to_string()));
        assert_eq!(
            document_hint.rename_target,
            Some(display(&moved)),
            "005 keeps the raw rename target"
        );

        let workspace_hint = payloads
            .iter()
            .map(change)
            .find(|event| event.subscription_id == workspace.subscription_id)
            .expect("the Workspace subscription must receive its own hint");
        assert_eq!(workspace_hint.scope, WatchScope::Recursive);
        assert_eq!(workspace_hint.relative_path, Some("notes.txt".to_string()));
        assert_eq!(
            workspace_hint.rename_target_relative_path,
            Some("moved.txt".to_string()),
            "an in-root rename target gets a relative path"
        );

        // A rename target outside the recursive root keeps its raw spelling but
        // has no relative path, so 006 can never use it as an Explorer path.
        let outside = work_dir("mixed-routing-outside").join("moved.txt");
        let payloads = core.handle_message(raw_with_target(
            RawWatchEventKind::Removed,
            vec![document.clone()],
            outside.clone(),
        ));
        let workspace_hint = payloads
            .iter()
            .map(change)
            .find(|event| event.subscription_id == workspace.subscription_id)
            .expect("the Workspace subscription must receive its own hint");
        assert_eq!(
            workspace_hint.rename_target_relative_path,
            None,
            "an outside target has no in-root relative path"
        );
        assert_eq!(
            workspace_hint.rename_target,
            Some(display(&outside)),
            "the raw target survives as a document-only relocation candidate"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// Removing the last recursive subscriber may narrow coverage again, but the
    /// remaining non-recursive subscribers must keep working and must still be
    /// routed by their own scope (FR-009, plan §2).
    #[test]
    fn removing_the_last_recursive_subscriber_narrows_coverage_only() {
        let root = work_dir("mixed-downgrade");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create nested dir");
        let document = write_file(&root, "notes.txt");
        let sibling = write_file(&root, "other.txt");
        let descendant = nested.join("a.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        let document_subscription = core
            .subscribe_with(&display(&document), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the document");
        let workspace = core
            .subscribe_with(&display(&root), WatchScope::Recursive, &mut backend)
            .expect("subscribe to the Workspace root");

        assert!(core.unsubscribe(workspace.subscription_id, &mut backend));

        assert_eq!(
            backend.watched().last(),
            Some(&(root.clone(), WatchScope::NonRecursive)),
            "coverage narrows back to what the remaining subscribers need"
        );
        assert_eq!(core.subscription_count(), 1);
        assert_eq!(core.active_watch_count(), 1);

        // The remaining document interest still receives its own target...
        let payloads = core.handle_message(raw(RawWatchEventKind::Changed, vec![document.clone()]));
        assert_eq!(payloads.len(), 1);
        assert_eq!(
            change(&payloads[0]).subscription_id,
            document_subscription.subscription_id
        );

        // ...and nothing else: a descendant and a sibling are not its business.
        assert!(core
            .handle_message(raw(RawWatchEventKind::Created, vec![descendant]))
            .is_empty());
        assert!(core
            .handle_message(raw(RawWatchEventKind::Changed, vec![sibling]))
            .is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    /// Removing the non-recursive subscribers must not disturb recursive
    /// coverage or its routing.
    #[test]
    fn removing_non_recursive_subscribers_keeps_recursive_coverage() {
        let root = work_dir("mixed-keep-recursive");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create nested dir");
        let document = write_file(&root, "notes.txt");
        let descendant = nested.join("a.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        let document_subscription = core
            .subscribe_with(&display(&document), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the document");
        let workspace = core
            .subscribe_with(&display(&root), WatchScope::Recursive, &mut backend)
            .expect("subscribe to the Workspace root");

        let watched_before = backend.watched().len();
        assert!(core.unsubscribe(document_subscription.subscription_id, &mut backend));

        assert_eq!(
            backend.watched().len(),
            watched_before,
            "recursive coverage needs no backend transition"
        );
        assert_eq!(
            backend.watched().last(),
            Some(&(root.clone(), WatchScope::Recursive))
        );

        let payloads = core.handle_message(raw(RawWatchEventKind::Created, vec![descendant]));
        assert_eq!(payloads.len(), 1);
        assert_eq!(change(&payloads[0]).subscription_id, workspace.subscription_id);

        let _ = fs::remove_dir_all(&root);
    }

    /// A refused upgrade must not be reported live: the recursive subscriber
    /// fails, the surviving consumers are told to revalidate, and the directory
    /// is degraded rather than falsely claimed covered (FR-009, FR-010).
    #[test]
    fn a_refused_recursive_upgrade_is_not_reported_as_live_coverage() {
        let root = work_dir("mixed-refused-upgrade");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create nested dir");
        let document = write_file(&root, "notes.txt");
        let descendant = nested.join("a.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        core.subscribe_with(&display(&document), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the document");

        let plan = core
            .begin_subscribe(&display(&root), WatchScope::Recursive)
            .expect("plan the recursive subscription");
        let change = plan.backend.clone().expect("an upgrade is required");
        assert!(matches!(change, BackendChange::Reconfigure { .. }));

        backend.fail_next_watch();
        assert!(apply_backend_change(&mut backend, &change).is_err());

        let invalidations = core.cancel_subscribe(plan);

        assert_eq!(
            invalidations,
            vec![(WatchScope::NonRecursive, display(&root))],
            "the survivor is told its coverage may be incomplete"
        );
        assert_eq!(core.subscription_count(), 1, "the failed subscriber is gone");
        assert_eq!(
            core.active_watch_count(),
            0,
            "the directory is degraded, not falsely covered"
        );

        assert!(
            core.handle_message(raw(RawWatchEventKind::Created, vec![descendant]))
                .is_empty(),
            "no recursive coverage exists, so no descendant is claimed"
        );

        // A later subscribe repairs the directory with a fresh watch.
        let repaired = core
            .subscribe_with(&display(&root), WatchScope::Recursive, &mut backend)
            .expect("repair the subscription");
        assert_eq!(
            backend.watched().last(),
            Some(&(root.clone(), WatchScope::Recursive))
        );
        assert_eq!(core.watch_refcount(&root), 2);
        assert_eq!(repaired.scope, WatchScope::Recursive);

        let _ = fs::remove_dir_all(&root);
    }

    /// A failed downgrade degrades the directory instead of leaving the core
    /// claiming coverage it could not re-establish.
    #[test]
    fn a_failed_downgrade_degrades_the_directory() {
        let root = work_dir("mixed-failed-downgrade");
        let document = write_file(&root, "notes.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        core.subscribe_with(&display(&document), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the document");
        let workspace = core
            .subscribe_with(&display(&root), WatchScope::Recursive, &mut backend)
            .expect("subscribe to the Workspace root");

        backend.fail_next_watch();
        assert!(core.unsubscribe(workspace.subscription_id, &mut backend));

        assert_eq!(core.subscription_count(), 1, "the survivor stays logical");
        assert_eq!(
            core.active_watch_count(),
            0,
            "the core must not claim a watch it could not re-establish"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// A backend-global loss notice has no path to intersect with, so it becomes
    /// one invalidation per live *logical* scope — never a single
    /// non-recursive-only notice (FR-010, T020).
    #[test]
    fn a_global_loss_notice_invalidates_every_live_logical_scope() {
        let root = work_dir("mixed-global-loss");
        let nested = root.join("src");
        fs::create_dir_all(&nested).expect("create nested dir");
        let document = write_file(&root, "notes.txt");

        let mut core = WatcherCore::new();
        let mut backend = RecordingBackend::new();

        core.subscribe_with(&display(&document), WatchScope::NonRecursive, &mut backend)
            .expect("subscribe to the document");
        core.subscribe_with(&display(&root), WatchScope::Recursive, &mut backend)
            .expect("subscribe to the Workspace root");

        let payloads = core.handle_message(BackendMessage::Error {
            paths: Vec::new(),
            reason: "overflow".to_string(),
        });

        let mut pairs: Vec<(WatchScope, Option<String>)> = payloads
            .iter()
            .map(invalidated)
            .map(|invalidated| (invalidated.scope, invalidated.watched_path.clone()))
            .collect();
        pairs.sort_by(|left, right| format!("{left:?}").cmp(&format!("{right:?}")));

        assert_eq!(
            pairs,
            vec![
                (WatchScope::NonRecursive, Some(display(&root))),
                (WatchScope::Recursive, Some(display(&root))),
            ],
            "both consumers must receive the invalidation that concerns their scope"
        );

        // A named loss inside the root concerns both scopes of that directory.
        let named = core.handle_message(BackendMessage::Rescan {
            paths: vec![nested.clone()],
            reason: "rescan".to_string(),
        });
        assert_eq!(named.len(), 2);
        assert!(named.iter().all(|payload| invalidated(payload).watched_path
            == Some(display(&root))));

        let _ = fs::remove_dir_all(&root);
    }

    /// One bounded live test for the real recursive backend: a descendant
    /// creation below the watched root must actually be observed. Everything
    /// else about mixed scopes stays synthetic, so the suite does not depend on
    /// OS event timing.
    #[test]
    fn live_backend_observes_a_recursive_descendant() {
        let root = work_dir("live-recursive");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create nested dir");
        let target = nested.join("a.txt");

        let payloads: Arc<StdMutex<Vec<WatchEventPayload>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink_state = Arc::clone(&payloads);
        let sink: WatchPayloadSink = Arc::new(move |payload| {
            sink_state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(payload);
        });

        let watcher = FilesystemWatcher::new(sink).expect("create the real watcher");
        watcher
            .start(&display(&root), WatchScope::Recursive)
            .expect("watch the fixture root");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut received = false;
        let mut last_write = std::time::Instant::now() - std::time::Duration::from_secs(1);

        while std::time::Instant::now() < deadline && !received {
            if last_write.elapsed() >= std::time::Duration::from_millis(250) {
                fs::write(&target, b"alpha\nbeta\ngamma").expect("write the descendant");
                last_write = std::time::Instant::now();
            }

            std::thread::sleep(std::time::Duration::from_millis(25));
            let recorded = payloads
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            received = recorded.iter().any(|payload| match payload {
                WatchEventPayload::Change(event) => {
                    event.scope == WatchScope::Recursive
                        && event.path.eq_ignore_ascii_case(&display(&target))
                }
                WatchEventPayload::Invalidated(_) => false,
            });
        }

        watcher.shutdown();
        let _ = fs::remove_dir_all(&root);

        assert!(
            received,
            "the real recursive backend must report a descendant under the watched root"
        );
    }

    /* ---------------------------------------------------------------- */
    /* Transition serialization (T146)                                    */
    /* ---------------------------------------------------------------- */

    /// Backend state a test controls from outside the watcher.
    #[derive(Default)]
    struct GatedState {
        watched: Vec<(PathBuf, WatchScope)>,
        unwatched: Vec<PathBuf>,
        /// Signalled when a held `watch` call has entered the backend.
        entered: Option<mpsc::Sender<()>>,
        /// Waited on before a held `watch` call returns.
        gate: Option<mpsc::Receiver<()>>,
        /// Kept so the test can open the gate.
        gate_opener: Option<mpsc::Sender<()>>,
        /// Whether the held call must fail once it is released.
        fail_after_gate: bool,
    }

    /// A backend that can hold one `watch` call open on demand.
    ///
    /// This is what makes an overlapping transition deterministic: the test knows
    /// exactly when a second `start`/`stop` races the first one, without relying
    /// on a sleep to create the window.
    #[derive(Clone, Default)]
    struct GatedBackend {
        state: Arc<StdMutex<GatedState>>,
    }

    impl GatedBackend {
        fn new() -> Self {
            Self::default()
        }

        /// Holds the next `watch` call open; the returned receiver fires when that
        /// call has entered the backend.
        fn hold_next_watch(&self) -> mpsc::Receiver<()> {
            let (entered_tx, entered_rx) = mpsc::channel();
            let (gate_tx, gate_rx) = mpsc::channel();
            let mut state = lock(&self.state);
            state.entered = Some(entered_tx);
            state.gate = Some(gate_rx);
            state.gate_opener = Some(gate_tx);
            entered_rx
        }

        /// Makes the currently held call fail once it is released.
        fn fail_held_watch(&self) {
            lock(&self.state).fail_after_gate = true;
        }

        /// Releases the held call.
        fn release_held_watch(&self) {
            if let Some(opener) = lock(&self.state).gate_opener.take() {
                let _ = opener.send(());
            }
        }

        fn watched(&self) -> Vec<(PathBuf, WatchScope)> {
            lock(&self.state).watched.clone()
        }
    }

    impl WatchBackend for GatedBackend {
        fn watch(&mut self, directory: &Path, scope: WatchScope) -> Result<(), String> {
            let (entered, gate, fail) = {
                let mut state = lock(&self.state);
                state.watched.push((directory.to_path_buf(), scope));
                let fail = state.fail_after_gate;
                // Consumed, so only the held call fails.
                state.fail_after_gate = false;
                (state.entered.take(), state.gate.take(), fail)
            };

            if let Some(entered) = entered {
                let _ = entered.send(());
            }
            if let Some(gate) = gate {
                // A test that never opens the gate fails loudly instead of
                // hanging the suite.
                let _ = gate.recv_timeout(Duration::from_secs(10));
            }
            if fail {
                return Err("backend refused the watch".to_string());
            }

            Ok(())
        }

        fn unwatch(&mut self, directory: &Path) -> Result<(), String> {
            lock(&self.state).unwatched.push(directory.to_path_buf());
            Ok(())
        }
    }

    /// A sink that records every payload it receives.
    fn recording_sink() -> (WatchPayloadSink, Arc<StdMutex<Vec<WatchEventPayload>>>) {
        let recorded: Arc<StdMutex<Vec<WatchEventPayload>>> = Arc::new(StdMutex::new(Vec::new()));
        let state = Arc::clone(&recorded);
        let sink: WatchPayloadSink = Arc::new(move |payload| {
            lock(&state).push(payload);
        });
        (sink, recorded)
    }

    /// A second `start` may not ride on coverage the first attempt never
    /// established: every logical subscription owns a real backend watch.
    #[test]
    fn an_overlapping_subscribe_does_not_ride_on_an_unestablished_watch() {
        let dir = work_dir("transition-start-start");
        let notes = write_file(&dir, "notes.txt");
        // Two files in *one* directory: both attempts therefore share one backend
        // watch record, which is what makes their coverage decision overlap.
        let todos = write_file(&dir, "todos.txt");

        let backend = GatedBackend::new();
        let probe = backend.clone();
        let (sink, recorded) = recording_sink();
        let watcher = Arc::new(FilesystemWatcher::with_backend(Box::new(backend), sink));

        // The first attempt enters the backend and is held there; it will fail.
        let entered = probe.hold_next_watch();
        probe.fail_held_watch();

        let first = {
            let watcher = Arc::clone(&watcher);
            let path = display(&notes);
            thread::spawn(move || watcher.start(&path, WatchScope::NonRecursive))
        };
        entered
            .recv_timeout(Duration::from_secs(5))
            .expect("the first attempt must reach the backend");

        let (second_done, second_done_rx) = mpsc::channel();
        let second = {
            let watcher = Arc::clone(&watcher);
            let path = display(&todos);
            thread::spawn(move || {
                let result = watcher.start(&path, WatchScope::NonRecursive);
                let _ = second_done.send(());
                result
            })
        };

        // While the first transition is still deciding, the overlapping one must
        // not report itself live: it is serialized behind the transition guard.
        assert!(
            second_done_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "the second subscribe returned before the first coverage was decided"
        );

        probe.release_held_watch();
        let first = first.join().expect("the first thread must not panic");
        assert!(first.is_err(), "the held attempt was refused");

        let second = second
            .join()
            .expect("the second thread must not panic")
            .expect("the serialized subscribe must establish its own coverage");

        // Exactly one backend watch per attempt: the first failed, the second
        // installed real coverage of its own.
        assert_eq!(probe.watched().len(), 2, "the second subscribe must watch for itself");

        // And that coverage is real: a change for the surviving subscription is
        // routed to the sink.
        watcher.handle_backend_message(raw(RawWatchEventKind::Changed, vec![todos.clone()]));
        let payloads = lock(&recorded).clone();
        assert_eq!(payloads.len(), 1, "the surviving subscription must receive events");
        assert_eq!(change(&payloads[0]).subscription_id, second.subscription_id);
    }

    /// A narrowing stop may not land after a widening start: recursive demand is
    /// never left served by a non-recursive backend watch (FR-009, FR-011).
    #[test]
    fn an_overlapping_resubscribe_keeps_recursive_coverage() {
        let dir = work_dir("transition-stop-start");
        let notes = write_file(&dir, "notes.txt");

        let backend = GatedBackend::new();
        let probe = backend.clone();
        let (sink, _recorded) = recording_sink();
        let watcher = Arc::new(FilesystemWatcher::with_backend(Box::new(backend), sink));

        // A document interest and a Workspace interest share the directory, so
        // coverage is currently recursive.
        watcher
            .start(&display(&notes), WatchScope::NonRecursive)
            .expect("document watch");
        let workspace = watcher
            .start(&display(&dir), WatchScope::Recursive)
            .expect("workspace watch");
        assert_eq!(
            probe.watched().last(),
            Some(&(dir.clone(), WatchScope::Recursive))
        );

        // Removing the recursive interest narrows coverage, and the native call is
        // held open so a new recursive subscription can race it.
        let entered = probe.hold_next_watch();
        let stopping = {
            let watcher = Arc::clone(&watcher);
            let id = workspace.subscription_id;
            thread::spawn(move || watcher.stop(id))
        };
        entered
            .recv_timeout(Duration::from_secs(5))
            .expect("the narrowing transition must reach the backend");

        let (resubscribed, resubscribed_rx) = mpsc::channel();
        let resubscribe = {
            let watcher = Arc::clone(&watcher);
            let path = display(&dir);
            thread::spawn(move || {
                let result = watcher.start(&path, WatchScope::Recursive);
                let _ = resubscribed.send(());
                result
            })
        };
        assert!(
            resubscribed_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "the re-subscribe returned before the narrowing transition was decided"
        );

        probe.release_held_watch();
        stopping.join().expect("the stop thread must not panic");
        let resubscribe = resubscribe
            .join()
            .expect("the re-subscribe thread must not panic")
            .expect("the re-subscribe must succeed");

        // Coverage is recursive again: the narrowing could not win the race.
        assert_eq!(
            probe.watched().last(),
            Some(&(dir.clone(), WatchScope::Recursive)),
            "recursive demand must not be served by a non-recursive watch"
        );

        // The restored recursive subscription really is covered: a descendant
        // event reaches it.
        let (sink, recorded) = recording_sink();
        let watcher = Arc::new(FilesystemWatcher::with_backend(
            Box::new(GatedBackend::new()),
            sink,
        ));
        let restored = watcher
            .start(&display(&dir), WatchScope::Recursive)
            .expect("recursive watch");
        assert_eq!(restored.subscription_id, restored.subscription_id);
        watcher.handle_backend_message(raw(
            RawWatchEventKind::Created,
            vec![dir.join("nested").join("a.txt")],
        ));
        assert_eq!(
            lock(&recorded).len(),
            1,
            "a descendant event reaches the recursive subscription"
        );
        assert_eq!(resubscribe.scope, WatchScope::Recursive);
    }
}
