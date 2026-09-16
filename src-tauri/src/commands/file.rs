//! Tauri file commands.
//!
//! These commands implement the `read_text_file` / `write_text_file` IPC
//! contract. They deliberately expose logical text plus file-format metadata
//! instead of raw filesystem access, and they delegate all byte-level work to
//! [`crate::file_codec`].

use crate::file_codec::{self, FileCommandError, TextFormat, WriteRequest};
use serde::Serialize;

/// Success payload of `read_text_file`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTextFileResult {
    /// UTF-8 text normalized to LF separators.
    pub text: String,
    /// Detected file metadata used for the next save.
    pub format: TextFormat,
}

/// Reads and decodes a text file into editor-ready text plus format metadata.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<OpenTextFileResult, FileCommandError> {
    let decoded = file_codec::decode_file(&path)?;
    Ok(OpenTextFileResult {
        text: decoded.text,
        format: decoded.format,
    })
}

/// Encodes and writes editor text to disk using the requested output format.
#[tauri::command]
pub fn write_text_file(request: WriteRequest) -> Result<(), FileCommandError> {
    file_codec::write_file(&request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_codec::{Bom, DetectedLineEnding, OutputLineEnding};
    use serde::Serialize;
    use serde_json::{json, Value};

    fn work_dir(name: &str) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "sorakada-command-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn to_json<T: Serialize>(value: &T) -> Value {
        serde_json::to_value(value).expect("serialize to json")
    }

    fn write_bytes(dir: &std::path::Path, name: &str, bytes: &[u8]) -> String {
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("write fixture");
        path.to_string_lossy().to_string()
    }

    /// Pins the JSON the frontend's `OpenTextFileResult` DTO reads.
    #[test]
    fn read_text_file_matches_the_ipc_contract_shape() {
        let dir = work_dir("read-shape");
        let path = write_bytes(&dir, "notes.txt", b"\xEF\xBB\xBFalpha\r\nbeta");

        let value = to_json(&read_text_file(path).expect("read should succeed"));

        assert_eq!(
            value.as_object().expect("object").len(),
            2,
            "OpenTextFileResult must carry exactly text + format"
        );
        assert_eq!(value["text"], json!("alpha\nbeta"));

        let format = value["format"].as_object().expect("format object");
        assert_eq!(format.len(), 4, "TextFormat must carry exactly four fields");
        assert_eq!(value["format"]["encoding"], json!("utf8"));
        assert_eq!(value["format"]["bom"], json!("utf8"));
        assert_eq!(value["format"]["detectedLineEnding"], json!("crlf"));
        assert_eq!(value["format"]["preferredLineEnding"], json!("crlf"));

        // The frontend reads camelCase only; a snake_case regression here would
        // be invisible to `cargo test` without this assertion.
        assert!(format.get("detected_line_ending").is_none());
        assert!(format.get("preferred_line_ending").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pins the JSON the frontend's `FileCommandError` DTO reads.
    #[test]
    fn read_text_file_errors_match_the_ipc_contract_shape() {
        let dir = work_dir("read-errors");
        let binary = write_bytes(&dir, "unsupported.bin", b"a\0b");
        let bare_cr = write_bytes(&dir, "standalone-cr.txt", b"a\rb");
        let utf16 = write_bytes(&dir, "utf16.txt", &[0xFF, 0xFE, 0x41, 0x00]);
        let missing = dir.join("missing.txt").to_string_lossy().to_string();

        for (path, expected_code) in [
            (binary, "unsupported_binary"),
            (bare_cr, "unsupported_line_ending"),
            (utf16, "unsupported_encoding"),
            (missing, "io_read"),
        ] {
            let error = to_json(
                &read_text_file(path.clone()).expect_err(&format!("{expected_code} must fail")),
            );

            assert_eq!(error["code"], json!(expected_code));
            assert_eq!(
                error.as_object().expect("object").len(),
                2,
                "FileCommandError must carry exactly code + message"
            );
            assert!(
                error["message"]
                    .as_str()
                    .is_some_and(|message| !message.is_empty()),
                "message must be non-empty for the native error dialog"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pins the camelCase request the frontend sends to `write_text_file`.
    #[test]
    fn write_text_file_accepts_the_camel_case_frontend_request() {
        let dir = work_dir("write-shape");
        let path = dir.join("out.txt").to_string_lossy().to_string();

        let request: WriteRequest = serde_json::from_value(json!({
            "path": path,
            "text": "one\ntwo",
            "bom": "none",
            "lineEnding": "crlf",
        }))
        .expect("deserialize the frontend request shape");

        write_text_file(request).expect("write should succeed");
        assert_eq!(
            std::fs::read(&path).expect("read back"),
            b"one\r\ntwo".to_vec()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Quickstart Scenario A through the real command layer: the four uniform
    /// BOM/EOL combinations must round-trip byte-for-byte.
    #[test]
    fn command_layer_round_trips_the_four_uniform_bom_eol_combinations() {
        let dir = work_dir("uniform");
        let cases: [(&str, Bom, OutputLineEnding, &[u8]); 4] = [
            (
                "utf8-lf.txt",
                Bom::None,
                OutputLineEnding::Lf,
                b"alpha\nbeta\n",
            ),
            (
                "utf8-crlf.txt",
                Bom::None,
                OutputLineEnding::Crlf,
                b"alpha\r\nbeta\r\n",
            ),
            (
                "utf8bom-lf.txt",
                Bom::Utf8,
                OutputLineEnding::Lf,
                b"\xEF\xBB\xBFalpha\nbeta\n",
            ),
            (
                "utf8bom-crlf.txt",
                Bom::Utf8,
                OutputLineEnding::Crlf,
                b"\xEF\xBB\xBFalpha\r\nbeta\r\n",
            ),
        ];

        for (name, bom, line_ending, bytes) in cases {
            let path = write_bytes(&dir, name, bytes);

            let opened = read_text_file(path.clone()).expect("read should succeed");
            assert_eq!(opened.text, "alpha\nbeta\n", "{name}: normalized text");
            assert_eq!(opened.format.bom, bom, "{name}: BOM detection");
            assert_eq!(
                opened.format.preferred_line_ending, line_ending,
                "{name}: preferred EOL"
            );

            write_text_file(WriteRequest {
                path: path.clone(),
                text: opened.text,
                bom: opened.format.bom,
                line_ending: opened.format.preferred_line_ending,
            })
            .expect("write should succeed");

            assert_eq!(
                std::fs::read(&path).expect("read back"),
                bytes.to_vec(),
                "{name}: bytes after an untouched save"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Quickstart Scenarios C and H through the real command layer.
    #[test]
    fn command_layer_preserves_mixed_whitespace_and_final_newline_decisions() {
        let dir = work_dir("edges");

        // Mixed with CRLF dominant: detected Mixed, written back as CRLF.
        let mixed = write_bytes(&dir, "mixed.txt", b"a\r\nb\nc\r\n");
        let opened = read_text_file(mixed.clone()).expect("read should succeed");
        assert_eq!(opened.text, "a\nb\nc\n");
        assert_eq!(
            opened.format.detected_line_ending,
            DetectedLineEnding::Mixed
        );
        assert_eq!(
            opened.format.preferred_line_ending,
            OutputLineEnding::Crlf
        );

        // No final newline plus trailing spaces must survive a save untouched.
        let trailing = write_bytes(&dir, "no-final-newline.txt", b"keep   \nme");
        let opened = read_text_file(trailing.clone()).expect("read should succeed");
        assert_eq!(opened.text, "keep   \nme");
        assert_eq!(
            opened.format.detected_line_ending,
            DetectedLineEnding::Lf
        );

        write_text_file(WriteRequest {
            path: trailing.clone(),
            text: opened.text,
            bom: opened.format.bom,
            line_ending: opened.format.preferred_line_ending,
        })
        .expect("write should succeed");

        assert_eq!(
            std::fs::read(&trailing).expect("read back"),
            b"keep   \nme".to_vec(),
            "trailing spaces and the absent final newline must be preserved"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
