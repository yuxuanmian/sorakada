//! External-open request intake and pending-queue coordination.
//!
//! The queue is application-lifetime memory. A secondary process enqueues its
//! complete argument batch before notifying the main window; the notification
//! is not the request's storage. The single instance plugin and IPC commands
//! share this state through cheap clones of the same allocation.

use std::{
    collections::VecDeque,
    ffi::OsString,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const EXTERNAL_OPEN_PENDING_EVENT: &str = "external-open-pending";

/// One launch batch delivered to the main window.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalOpenRequest {
    pub id: u64,
    pub paths: Vec<String>,
}

#[derive(Debug)]
struct PendingExternalOpen {
    next_id: u64,
    requests: VecDeque<ExternalOpenRequest>,
}

impl Default for PendingExternalOpen {
    fn default() -> Self {
        Self {
            next_id: 1,
            requests: VecDeque::new(),
        }
    }
}

/// Shared FIFO state for cold-start and subsequent-instance requests.
#[derive(Clone, Default)]
pub struct ExternalOpenState {
    inner: Arc<Mutex<PendingExternalOpen>>,
}

impl ExternalOpenState {
    /// Appends one complete batch and returns its monotonically increasing ID.
    pub fn enqueue<I>(&self, paths: I) -> u64
    where
        I: IntoIterator<Item = String>,
    {
        let mut state = lock(&self.inner);
        let id = state.next_id;
        state.next_id = state.next_id.wrapping_add(1);
        state.requests.push_back(ExternalOpenRequest {
            id,
            paths: paths.into_iter().collect(),
        });
        id
    }

    /// Returns a copy of the queue head without changing queue state.
    pub fn peek(&self) -> Option<ExternalOpenRequest> {
        lock(&self.inner).requests.front().cloned()
    }

    /// Removes the queue head only when its ID matches `request_id`.
    pub fn ack(&self, request_id: u64) -> bool {
        let mut state = lock(&self.inner);
        if state.requests.front().map(|request| request.id) == Some(request_id) {
            state.requests.pop_front();
            true
        } else {
            false
        }
    }
}

/// Converts one process launch's argument array into path strings.
///
/// The executable argument is skipped. The first standalone `--` ends option
/// interpretation and is not a path; every other argument is retained without
/// trimming, quote removal, shell expansion, existence checks or canonicalization.
/// Relative paths use only the supplied request-specific working directory.
pub fn paths_from_args<I, S>(args: I, cwd: &Path) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut options_ended = false;
    let mut paths = Vec::new();

    for argument in args.into_iter().map(Into::<OsString>::into).skip(1) {
        let argument = argument.to_string_lossy();
        if !options_ended && argument == "--" {
            options_ended = true;
            continue;
        }

        let path = Path::new(argument.as_ref());
        let resolved = if path.is_absolute() {
            path.to_path_buf()
        } else {
            cwd.join(path)
        };
        paths.push(resolved.to_string_lossy().into_owned());
    }

    paths
}

/// Enqueues a secondary launch, wakes the main window, and attempts activation.
pub fn handle_instance(
    app: &tauri::AppHandle,
    state: &ExternalOpenState,
    args: Vec<String>,
    cwd: String,
) {
    state.enqueue(paths_from_args(args, Path::new(&cwd)));
    activate_main_window(app);
    let _ = app.emit_to(MAIN_WINDOW_LABEL, EXTERNAL_OPEN_PENDING_EVENT, ());
}

/// Attempts to show, restore and focus the main window without failing intake.
pub fn activate_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };

    let _ = window.show();
    if window.is_minimized().unwrap_or(true) {
        let _ = window.unminimize();
    }
    let _ = window.set_focus();
}

/// IPC commands accept only the application's main window as their caller.
pub fn is_main_window_label(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsString, path::PathBuf};

    use serde_json::json;

    use super::{
        is_main_window_label, paths_from_args, ExternalOpenRequest, ExternalOpenState,
        EXTERNAL_OPEN_PENDING_EVENT, MAIN_WINDOW_LABEL,
    };

    #[test]
    fn arguments_skip_the_executable_and_preserve_each_path_argument() {
        let cwd = PathBuf::from(r"C:\工作 目录");
        let args = vec![
            OsString::from(r"C:\Program Files\Sorakada\sorakada.exe"),
            OsString::from("first file.txt"),
            OsString::from("--"),
            OsString::from(r"C:\绝对 路径\文件.txt"),
            OsString::from("after delimiter.txt"),
            OsString::from(r#""literal quotes.txt""#),
        ];

        assert_eq!(
            paths_from_args(args, &cwd),
            vec![
                cwd.join("first file.txt").to_string_lossy().into_owned(),
                r"C:\绝对 路径\文件.txt".to_string(),
                cwd.join("after delimiter.txt")
                    .to_string_lossy()
                    .into_owned(),
                cwd.join(r#""literal quotes.txt""#)
                    .to_string_lossy()
                    .into_owned(),
            ]
        );
    }

    #[test]
    fn only_the_first_standalone_double_dash_is_consumed() {
        let cwd = PathBuf::from(r"C:\request cwd");
        let args = vec![
            OsString::from("sorakada.exe"),
            OsString::from("--"),
            OsString::from("--"),
            OsString::from("--literal"),
        ];

        assert_eq!(
            paths_from_args(args, &cwd),
            vec![
                cwd.join("--").to_string_lossy().into_owned(),
                cwd.join("--literal").to_string_lossy().into_owned(),
            ]
        );
    }

    #[test]
    fn no_file_arguments_still_form_an_empty_batch() {
        let cwd = PathBuf::from(r"C:\request cwd");

        assert!(paths_from_args(vec![OsString::from("sorakada.exe")], &cwd).is_empty());
        assert!(paths_from_args(
            vec![OsString::from("sorakada.exe"), OsString::from("--")],
            &cwd
        )
        .is_empty());
    }

    #[test]
    fn relative_paths_are_not_filtered_or_canonicalized() {
        let cwd = PathBuf::from(r"C:\request cwd");
        let args = vec![
            OsString::from("sorakada.exe"),
            OsString::from(r"missing\..\不存在 文件.txt"),
        ];

        assert_eq!(
            paths_from_args(args, &cwd),
            vec![cwd
                .join(r"missing\..\不存在 文件.txt")
                .to_string_lossy()
                .into_owned()]
        );
    }

    #[cfg(windows)]
    #[test]
    fn unc_paths_remain_absolute() {
        let cwd = PathBuf::from(r"C:\request cwd");
        let unc = r"\\server\share\目录\file 名.txt";
        let args = vec![OsString::from("sorakada.exe"), OsString::from(unc)];

        assert_eq!(paths_from_args(args, &cwd), vec![unc.to_string()]);
    }

    #[test]
    fn queue_is_fifo_and_peek_is_non_destructive() {
        let state = ExternalOpenState::default();
        let first = state.enqueue(vec![r"C:\first.txt".to_string()]);
        let second = state.enqueue(vec![r"C:\second.txt".to_string()]);

        let head = state.peek().expect("first request");
        assert_eq!(head.id, first);
        assert_eq!(head.paths, vec![r"C:\first.txt".to_string()]);
        assert_eq!(state.peek(), Some(head));

        assert!(state.ack(first));
        assert_eq!(state.peek().expect("second request").id, second);
    }

    #[test]
    fn stale_and_repeated_acknowledgements_do_not_remove_later_requests() {
        let state = ExternalOpenState::default();
        let first = state.enqueue(Vec::<String>::new());
        let second = state.enqueue(vec![r"C:\second.txt".to_string()]);

        assert!(!state.ack(second));
        assert_eq!(state.peek().expect("first remains").id, first);

        assert!(state.ack(first));
        assert!(!state.ack(first));
        assert_eq!(state.peek().expect("second remains").id, second);

        assert!(state.ack(second));
        assert_eq!(state.peek(), None);
        assert!(!state.ack(second));
    }

    #[test]
    fn cold_start_batch_stays_ahead_of_later_instance_batches() {
        let cwd = PathBuf::from(r"C:\request cwd");
        let state = ExternalOpenState::default();
        state.enqueue(paths_from_args(
            vec![
                OsString::from("sorakada.exe"),
                OsString::from("cold start.txt"),
            ],
            &cwd,
        ));
        state.enqueue(paths_from_args(
            vec![
                OsString::from("sorakada.exe"),
                OsString::from("later instance.txt"),
            ],
            &cwd,
        ));

        assert_eq!(
            state.peek().expect("cold-start request").paths,
            vec![cwd.join("cold start.txt").to_string_lossy().into_owned()]
        );
    }

    #[test]
    fn external_open_request_and_empty_queue_use_the_exact_json_contract() {
        let request = ExternalOpenRequest {
            id: 42,
            paths: vec![
                r"C:\目录\文件 名.txt".to_string(),
                r"\\server\share\file.md".to_string(),
            ],
        };
        let value = serde_json::to_value(&request).expect("serialize request");

        assert_eq!(
            value,
            json!({
                "id": 42,
                "paths": [r"C:\目录\文件 名.txt", r"\\server\share\file.md"]
            })
        );
        assert_eq!(
            serde_json::from_value::<ExternalOpenRequest>(value).expect("decode request"),
            request
        );

        let empty = ExternalOpenRequest {
            id: 7,
            paths: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(empty).expect("serialize empty request"),
            json!({"id": 7, "paths": []})
        );
        assert_eq!(
            serde_json::to_value(Option::<ExternalOpenRequest>::None).expect("null head"),
            serde_json::Value::Null
        );
    }

    #[test]
    fn event_and_window_names_are_fixed() {
        assert_eq!(EXTERNAL_OPEN_PENDING_EVENT, "external-open-pending");
        assert_eq!(MAIN_WINDOW_LABEL, "main");
        assert!(is_main_window_label("main"));
        assert!(!is_main_window_label("secondary"));
    }
}
