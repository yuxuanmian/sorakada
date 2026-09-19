//! Event-driven filesystem watching.
//!
//! 005 needs to learn that a file it has open changed on disk without polling
//! it. This module owns that capability and nothing else: it knows about
//! directories, subscriptions, refcounts and normalized hints, but it does not
//! know what a document, a session, an editor or a Workspace is. The 005
//! consumer lives in the React layer and 006 will reuse this manager for a
//! recursive Workspace watch.
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
struct WatchRecord {
    /// `comparison_key` of `directory`; the sharing key.
    directory_key: String,
    /// The canonical directory passed to the backend.
    directory: PathBuf,
    /// The backend mode chosen by the first subscription of this directory.
    scope: WatchScope,
    /// How many subscriptions currently depend on this backend watch.
    refcount: usize,
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
    /// The scope to watch it with.
    pub scope: WatchScope,
    /// Whether this plan is the first interest in `directory` and therefore
    /// requires a backend `watch` call.
    pub needs_backend_watch: bool,
}

/// The result of detaching a subscription from the core.
struct DetachedSubscription {
    /// The directory to unwatch when the last interest in it was released.
    unwatch_directory: Option<PathBuf>,
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
        // watch. The first subscription of a directory chooses the backend
        // mode; 005 and 006 never mix scopes on one directory.
        let needs_backend_watch = match self
            .watches
            .iter_mut()
            .find(|watch| watch.directory_key == directory_key)
        {
            Some(watch) => {
                watch.refcount += 1;
                false
            }
            None => {
                self.watches.push(WatchRecord {
                    directory_key,
                    directory: canonical.clone(),
                    scope,
                    refcount: 1,
                });
                true
            }
        };

        Ok(SubscribePlan {
            subscription_id,
            directory: canonical,
            scope,
            needs_backend_watch,
        })
    }

    /// Finalizes a plan whose backend watch succeeded.
    pub fn confirm_subscribe(&mut self, plan: SubscribePlan) -> WatchSubscription {
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

    /// Rolls a plan back after its backend watch failed.
    ///
    /// No backend `unwatch` is issued because the caller only cancels a plan
    /// whose watch never succeeded; the core only drops its own bookkeeping.
    pub fn cancel_subscribe(&mut self, plan: SubscribePlan) {
        let _ = self.detach_subscription(plan.subscription_id);
    }

    /// Convenience single-threaded composition (begin -> backend.watch ->
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

        if plan.needs_backend_watch {
            if let Err(message) = backend.watch(&plan.directory, plan.scope) {
                let message = format!("Cannot watch {}: {message}", plan.directory.display());
                self.cancel_subscribe(plan);
                return Err(FileCommandError::new(CODE_PATH_RESOLUTION, message));
            }
        }

        Ok(self.confirm_subscribe(plan))
    }

    /// Removes a subscription; releases the shared parent watch when its
    /// refcount hits zero.
    ///
    /// Returns false for an unknown id, so stopping twice is harmless.
    #[allow(dead_code)]
    pub fn unsubscribe(&mut self, subscription_id: u64, backend: &mut dyn WatchBackend) -> bool {
        match self.detach_subscription(subscription_id) {
            Some(detached) => {
                if let Some(directory) = detached.unwatch_directory {
                    let _ = backend.unwatch(&directory);
                }
                true
            }
            None => false,
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
            .map(|watch| watch.refcount)
            .unwrap_or(0)
    }

    /// Removes a subscription's bookkeeping and reports what to unwatch.
    ///
    /// Shared by [`WatcherCore::unsubscribe`] and [`FilesystemWatcher::stop`],
    /// so the manager can perform the backend call without holding the core
    /// lock at the same time as the backend lock.
    fn detach_subscription(&mut self, subscription_id: u64) -> Option<DetachedSubscription> {
        // Both lookups happen before anything is mutated, so an unknown
        // identifier leaves the bookkeeping exactly as it was.
        let index = self
            .subscriptions
            .iter()
            .position(|record| record.subscription_id == subscription_id)?;
        let directory_key = self.subscriptions[index].directory_key.clone();
        let watch_index = self
            .watches
            .iter()
            .position(|watch| watch.directory_key == directory_key)?;

        self.subscriptions.remove(index);

        let refcount = {
            let watch = &mut self.watches[watch_index];
            watch.refcount = watch.refcount.saturating_sub(1);
            watch.refcount
        };

        if refcount > 0 {
            return Some(DetachedSubscription {
                unwatch_directory: None,
            });
        }

        let watch = self.watches.remove(watch_index);
        Some(DetachedSubscription {
            unwatch_directory: Some(watch.directory),
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
                }));
            }
        }

        payloads
    }

    /// Turns a lost-completeness notice into per-directory invalidations.
    fn invalidations(&self, paths: &[PathBuf], reason: &str) -> Vec<WatchEventPayload> {
        // No usable path means the backend cannot say what is still reliable,
        // so every interest must be revalidated. This is the one case that
        // produces a payload even when nothing is currently watched.
        if paths.is_empty() {
            return vec![WatchEventPayload::Invalidated(WatchInvalidated {
                scope: WatchScope::NonRecursive,
                watched_path: None,
                reason: reason.to_string(),
            })];
        }

        self.watches
            .iter()
            .filter(|watch| {
                paths
                    .iter()
                    .any(|path| path_affects_directory(path, &watch.directory))
            })
            .map(|watch| {
                WatchEventPayload::Invalidated(WatchInvalidated {
                    scope: watch.scope,
                    watched_path: Some(watch.directory.to_string_lossy().to_string()),
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

                // Compare identity keys rather than raw strings: no disk access
                // is allowed here, because the path may already be gone.
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
/// Locking rule: the core mutex and the backend mutex are never held at the
/// same time. `start` takes the core, releases it, takes the backend, releases
/// it, and takes the core again; `stop` and `shutdown` detach the bookkeeping
/// first and only then call the backend. The notify handler closure owns only
/// the core and the sink, so no lock ordering between the two can deadlock.
pub struct FilesystemWatcher {
    /// Subscription/reference bookkeeping, also shared with the handler.
    core: Arc<Mutex<WatcherCore>>,
    /// The real backend, behind its own mutex so calls do not serialize with
    /// event delivery.
    backend: Mutex<Box<dyn WatchBackend>>,
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
            sink,
        })
    }

    /// Test/extension seam: any backend.
    #[allow(dead_code)]
    pub fn with_backend(backend: Box<dyn WatchBackend>, sink: WatchPayloadSink) -> Self {
        Self {
            core: Arc::new(Mutex::new(WatcherCore::new())),
            backend: Mutex::new(backend),
            sink,
        }
    }

    /// Registers interest in `path` and returns the subscription handle.
    pub fn start(
        &self,
        path: &str,
        scope: WatchScope,
    ) -> Result<WatchSubscription, FileCommandError> {
        // Core lock only: decide what must happen and reserve the refcount.
        let plan = lock(&self.core).begin_subscribe(path, scope)?;

        if plan.needs_backend_watch {
            // Backend lock only, released before the core is touched again.
            // Perform the OS call before confirming, so a refusal is never
            // reported to the frontend as a live subscription.
            let watched = lock(&self.backend).watch(&plan.directory, plan.scope);
            if let Err(message) = watched {
                let message = format!("Cannot watch {}: {message}", plan.directory.display());
                lock(&self.core).cancel_subscribe(plan);
                return Err(FileCommandError::new(CODE_PATH_RESOLUTION, message));
            }
        }

        // Core lock only again.
        Ok(lock(&self.core).confirm_subscribe(plan))
    }

    /// Idempotent: stopping an unknown subscription succeeds.
    pub fn stop(&self, subscription_id: u64) {
        let detached = lock(&self.core).detach_subscription(subscription_id);

        if let Some(DetachedSubscription {
            unwatch_directory: Some(directory),
        }) = detached
        {
            let _ = lock(&self.backend).unwatch(&directory);
        }
    }

    /// Releases every watch. Called on application shutdown.
    pub fn shutdown(&self) {
        // Bound before the loop so the core guard is released before the
        // backend lock is taken.
        let directories = lock(&self.core).detach_all();

        for directory in directories {
            let _ = lock(&self.backend).unwatch(&directory);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Mutex as StdMutex;

    use serde_json::{json, Value};

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
        // reliable, so every interest must be revalidated. No directory is
        // named, which is exactly the pinned `watchedPath: null` shape.
        let unnamed = core.handle_message(BackendMessage::Error {
            paths: Vec::new(),
            reason: "overflow".to_string(),
        });
        assert_eq!(unnamed.len(), 1);
        assert_eq!(invalidated(&unnamed[0]).watched_path, None);
        assert_eq!(invalidated(&unnamed[0]).scope, WatchScope::NonRecursive);
        assert_eq!(
            serde_json::to_value(&unnamed[0]).expect("serialize the invalidation"),
            json!({
                "type": "invalidated",
                "scope": "nonRecursive",
                "watchedPath": Value::Null,
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
}
