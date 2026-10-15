//! Normalized filesystem watch events.
//!
//! 005 turns native filesystem notifications into hints that the React layer
//! revalidates against the real disk before any document state changes. This
//! module owns the *shape* of that hint channel and nothing else: it is
//! deliberately free of document, session, editor and Workspace vocabulary so
//! that 006 can reuse the exact same payloads for a recursive Workspace watch.
//!
//! Every type here is a wire contract. The Rust side pins the serialized JSON
//! in its own tests and the TypeScript adapter decodes the same spellings, so
//! the 005 consumer never has to agree with the backend about anything except
//! these DTOs.

use serde::{Deserialize, Serialize};

/// Event name the backend emits normalized payloads on.
///
/// It is a plain Tauri channel name rather than a command, because watch hints
/// arrive whenever the operating system raises them and no caller is waiting.
pub const WATCH_EVENT_NAME: &str = "filesystem-watch-event";

/// How much of the tree a subscription observes.
///
/// 005 subscribes non-recursively to the parent directory of a bound document.
/// The recursive variant exists because 006 needs a Workspace root watch, and
/// building the scope abstraction now avoids a second watcher design later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatchScope {
    /// Only the watched directory level is observed.
    NonRecursive,
    /// The watched directory and every descendant are observed.
    Recursive,
}

/// What a raw filesystem occurrence is believed to be.
///
/// The hint is intentionally coarse: rename/move is never inferred from it, and
/// the consumer revalidates the path on disk before trusting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WatchChangeHint {
    /// Something appeared at the path.
    Created,
    /// Something at the path was written or otherwise mutated in place.
    Changed,
    /// Something at the path disappeared.
    Removed,
    /// The backend saw an occurrence it cannot classify further.
    Other,
}

/// One normalized change hint for one subscription.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    /// The subscription this hint belongs to, so the consumer can ignore hints
    /// for interest it has already released.
    pub subscription_id: u64,
    /// The scope of that subscription, echoed for consumer-side revalidation.
    pub scope: WatchScope,
    /// The directory the backend actually watches, which for 005 is the parent
    /// directory rather than the requested document path.
    pub watched_path: String,
    /// The path the hint refers to, exactly as the backend observed it.
    pub path: String,
    /// Coarse classification of what happened at `path`.
    pub hint: WatchChangeHint,
    /// Rename destination when the backend reported a paired rename.
    ///
    /// Preserved for the 006 Workspace consumer, which may offer a paired
    /// source/target as a *candidate*; it is never rename proof and 005 never
    /// infers a document path migration from it.
    pub rename_target: Option<String>,
    /// `path` relative to this subscription's watched directory (006).
    ///
    /// The backend watches a canonical directory spelling that can differ from
    /// the logical Workspace root the user chose (a junction, a `\\?\` prefix, a
    /// case-only difference). Computing the relative path here — with the same
    /// platform-aware containment helper the rest of the crate uses — is what
    /// lets the Workspace consumer join it back onto its own logical root
    /// instead of comparing raw watcher path text against Tree paths (FR-118).
    ///
    /// `None` means the event path is not inside the watched directory (which a
    /// recursive subscription's own root-self event also is not). 005 ignores
    /// this field entirely.
    pub relative_path: Option<String>,
    /// `rename_target` relative to this subscription's watched directory.
    ///
    /// `None` when there is no rename target *or* when the target lies outside
    /// this subscription's watch — an outside target is a document-relocation
    /// candidate only and must never be used as an Explorer path (FR-049,
    /// FR-118).
    pub rename_target_relative_path: Option<String>,
}

/// Notice that a watch can no longer be trusted to be complete.
///
/// Filesystem notification streams can overflow or fail. Rather than inventing
/// hints for events that were lost, the backend says "revalidate": the consumer
/// then reads the real disk state with its own validation path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchInvalidated {
    /// Scope of the watch whose guarantees were lost.
    pub scope: WatchScope,
    /// The watched directory that must be revalidated, or `None` when every
    /// interest has to be revalidated because the backend could not name one.
    pub watched_path: Option<String>,
    /// Human-readable backend reason, forwarded for diagnostics only.
    pub reason: String,
}

/// Everything the backend can hand to the frontend on the watch channel.
///
/// The two variants are tagged so the consumer can branch before decoding
/// details, and so a change can never be mistaken for an invalidation (or the
/// other way around) when the payload is parsed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WatchEventPayload {
    /// A hint that something changed at a path.
    Change(WatchEvent),
    /// A hint that the change stream itself is no longer complete.
    Invalidated(WatchInvalidated),
}

/// Command argument of `start_filesystem_watch`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWatchRequest {
    /// The path the consumer wants to observe.
    pub path: String,
    /// How much of the tree must be observed around that path.
    pub scope: WatchScope,
}

/// Command argument of `stop_filesystem_watch`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopWatchRequest {
    /// Identifier returned by `start_filesystem_watch`.
    pub subscription_id: u64,
}

/// Command result of `start_filesystem_watch`.
///
/// It echoes the requested path next to the concrete watched directory, because
/// the consumer keys its interest on the requested path while diagnostics and
/// invalidation work on the directory the backend really watches.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSubscription {
    /// Identifier the consumer passes back to `stop_filesystem_watch`.
    pub subscription_id: u64,
    /// The path that was requested, unchanged.
    pub path: String,
    /// The directory the backend watches for that request.
    pub watched_path: String,
    /// Scope the subscription was created with.
    pub scope: WatchScope,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Pins the normalized change payload the frontend's `WatchEventPayload`
    /// decoder reads.
    #[test]
    fn change_payload_matches_the_pinned_wire_shape() {
        let payload = WatchEventPayload::Change(WatchEvent {
            subscription_id: 1,
            scope: WatchScope::NonRecursive,
            watched_path: "C:\\work".to_string(),
            path: "C:\\work\\notes.txt".to_string(),
            hint: WatchChangeHint::Changed,
            rename_target: None,
            relative_path: Some("notes.txt".to_string()),
            rename_target_relative_path: None,
        });

        assert_eq!(
            serde_json::to_value(&payload).expect("serialize the change payload"),
            json!({
                "type": "change",
                "subscriptionId": 1,
                "scope": "nonRecursive",
                "watchedPath": "C:\\work",
                "path": "C:\\work\\notes.txt",
                "hint": "changed",
                "renameTarget": null,
                "relativePath": "notes.txt",
                "renameTargetRelativePath": null,
            })
        );
    }

    /// 006 maps a hinted path onto its logical root through the
    /// subscription-relative fields, so both the inside and the outside forms
    /// are pinned here: an outside rename target has no relative path while its
    /// raw target is preserved for a document-only relocation candidate.
    #[test]
    fn change_payload_pins_the_subscription_relative_location_fields() {
        let inside = WatchEventPayload::Change(WatchEvent {
            subscription_id: 9,
            scope: WatchScope::Recursive,
            watched_path: "D:\\project".to_string(),
            path: "D:\\project\\src\\renamed.ts".to_string(),
            hint: WatchChangeHint::Removed,
            rename_target: Some("D:\\project\\src\\target.ts".to_string()),
            relative_path: Some("src\\renamed.ts".to_string()),
            rename_target_relative_path: Some("src\\target.ts".to_string()),
        });

        let value = serde_json::to_value(&inside).expect("serialize the inside rename");
        assert_eq!(value["relativePath"], json!("src\\renamed.ts"));
        assert_eq!(value["renameTargetRelativePath"], json!("src\\target.ts"));

        let outside = WatchEventPayload::Change(WatchEvent {
            subscription_id: 9,
            scope: WatchScope::Recursive,
            watched_path: "D:\\project".to_string(),
            path: "D:\\project\\moved.txt".to_string(),
            hint: WatchChangeHint::Removed,
            rename_target: Some("D:\\elsewhere\\moved.txt".to_string()),
            relative_path: Some("moved.txt".to_string()),
            rename_target_relative_path: None,
        });

        let value = serde_json::to_value(&outside).expect("serialize the outside rename");
        assert_eq!(value["relativePath"], json!("moved.txt"));
        assert_eq!(
            value["renameTargetRelativePath"],
            json!(null),
            "an outside target has no relative path"
        );
        assert_eq!(
            value["renameTarget"],
            json!("D:\\elsewhere\\moved.txt"),
            "the raw target survives for a document-only relocation candidate"
        );

        // The watched directory itself is not inside itself, so a root-self
        // event carries no relative path either.
        let root_self = WatchEventPayload::Change(WatchEvent {
            subscription_id: 9,
            scope: WatchScope::Recursive,
            watched_path: "D:\\project".to_string(),
            path: "D:\\project".to_string(),
            hint: WatchChangeHint::Changed,
            rename_target: None,
            relative_path: None,
            rename_target_relative_path: None,
        });

        let value = serde_json::to_value(&root_self).expect("serialize the root-self event");
        assert_eq!(value["relativePath"], json!(null));
        assert_eq!(value["renameTargetRelativePath"], json!(null));
    }

    /// Pins the invalidation payload, including both of its identifying fields:
    /// the named watch directory and the unnamed "revalidate everything" form.
    #[test]
    fn invalidated_payload_matches_the_pinned_wire_shape() {
        let named = WatchEventPayload::Invalidated(WatchInvalidated {
            scope: WatchScope::NonRecursive,
            watched_path: Some("C:\\work".to_string()),
            reason: "overflow".to_string(),
        });

        assert_eq!(
            serde_json::to_value(&named).expect("serialize the invalidation payload"),
            json!({
                "type": "invalidated",
                "scope": "nonRecursive",
                "watchedPath": "C:\\work",
                "reason": "overflow",
            })
        );

        let unnamed = WatchEventPayload::Invalidated(WatchInvalidated {
            scope: WatchScope::NonRecursive,
            watched_path: None,
            reason: "overflow".to_string(),
        });

        assert_eq!(
            serde_json::to_value(&unnamed).expect("serialize the unnamed invalidation"),
            json!({
                "type": "invalidated",
                "scope": "nonRecursive",
                "watchedPath": null,
                "reason": "overflow",
            })
        );
    }

    /// Pins the response the frontend reads from `start_filesystem_watch`.
    #[test]
    fn watch_subscription_matches_the_pinned_wire_shape() {
        let subscription = WatchSubscription {
            subscription_id: 1,
            path: "C:\\work\\notes.txt".to_string(),
            watched_path: "C:\\work".to_string(),
            scope: WatchScope::NonRecursive,
        };

        assert_eq!(
            serde_json::to_value(&subscription).expect("serialize the subscription"),
            json!({
                "subscriptionId": 1,
                "path": "C:\\work\\notes.txt",
                "watchedPath": "C:\\work",
                "scope": "nonRecursive",
            })
        );
    }

    /// Pins the camelCase command arguments the frontend actually sends, and
    /// rejects the snake_case drift that would otherwise deserialize silently.
    #[test]
    fn command_arguments_accept_the_camel_case_frontend_shape() {
        let start: StartWatchRequest = serde_json::from_value(json!({
            "path": "C:\\work\\notes.txt",
            "scope": "nonRecursive",
        }))
        .expect("deserialize the start request shape");

        assert_eq!(start.path, "C:\\work\\notes.txt");
        assert_eq!(start.scope, WatchScope::NonRecursive);

        let stop: StopWatchRequest = serde_json::from_value(json!({
            "subscriptionId": 7,
        }))
        .expect("deserialize the stop request shape");

        assert_eq!(stop.subscription_id, 7);

        // `WatchScope` is camelCase only, exactly like `InspectPathRequest`'s
        // `allowMissing`; a snake_case spelling must fail loudly here.
        let snake_case_scope =
            serde_json::from_value::<StartWatchRequest>(json!({
                "path": "C:\\work\\notes.txt",
                "scope": "non_recursive",
            }));
        assert!(
            snake_case_scope.is_err(),
            "StartWatchRequest accepts the camelCase scope only"
        );

        let snake_case_id = serde_json::from_value::<StopWatchRequest>(json!({
            "subscription_id": 7,
        }));
        assert!(
            snake_case_id.is_err(),
            "StopWatchRequest accepts the camelCase id only"
        );
    }

    /// The recursive scope is already part of the wire contract so 006 does not
    /// have to change the payload shape it shares with 005.
    #[test]
    fn recursive_scope_serializes_for_the_future_workspace_watch() {
        let subscription = WatchSubscription {
            subscription_id: 4,
            path: "D:\\project".to_string(),
            watched_path: "D:\\project".to_string(),
            scope: WatchScope::Recursive,
        };

        let value = serde_json::to_value(&subscription).expect("serialize the subscription");

        assert_eq!(value["scope"], json!("recursive"));
        assert_eq!(
            serde_json::from_value::<WatchScope>(json!("recursive")).expect("decode scope"),
            WatchScope::Recursive
        );
    }

    /// Every hint spelling is part of the contract the frontend switches on.
    #[test]
    fn change_hints_use_the_lowercase_wire_spelling() {
        for (hint, expected) in [
            (WatchChangeHint::Created, "created"),
            (WatchChangeHint::Changed, "changed"),
            (WatchChangeHint::Removed, "removed"),
            (WatchChangeHint::Other, "other"),
        ] {
            assert_eq!(
                serde_json::to_value(hint).expect("serialize the hint"),
                json!(expected)
            );
        }
    }
}
