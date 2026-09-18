//! Byte-level text file codec.
//!
//! This module owns the translation between raw file bytes and the normalized
//! Unicode text handed to the editor:
//!
//! - UTF-8 BOM detection/removal on read, optional re-emission on write
//! - strict UTF-8 decoding (never lossy), UTF-16 and binary rejection
//! - LF/CRLF/Mixed line-ending analysis with a concrete preferred output style
//! - CRLF -> LF normalization for text returned to the editor
//! - logical LF -> requested separator conversion plus optional BOM on write
//!
//! No trimming, Unicode normalization, or final-newline insertion/removal is
//! performed in either direction.

use serde::{Deserialize, Serialize};

/// UTF-8 byte order mark.
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
/// UTF-16 little-endian byte order mark.
const UTF16_LE_BOM: [u8; 2] = [0xFF, 0xFE];
/// UTF-16 big-endian byte order mark.
const UTF16_BE_BOM: [u8; 2] = [0xFE, 0xFF];

/// Error code reported when the bytes cannot be read from or written to disk.
const CODE_IO_READ: &str = "io_read";
/// Error code reported when a write operation fails.
const CODE_IO_WRITE: &str = "io_write";
/// Error code reported when the payload is not supported UTF-8 text.
const CODE_UNSUPPORTED_ENCODING: &str = "unsupported_encoding";
/// Error code reported when the payload looks like binary content.
const CODE_UNSUPPORTED_BINARY: &str = "unsupported_binary";
/// Error code reported when a bare CR byte is present.
const CODE_UNSUPPORTED_LINE_ENDING: &str = "unsupported_line_ending";
// Structural 003 codes (`io_directory`, `io_create`, `io_rename`, `io_trash`)
// live next to the primitives that raise them, in `crate::workspace_fs`; the
// `path_resolution` code lives in `crate::file_identity`. All of them are
// carried by the same `FileCommandError` shape below.

/// Byte order mark presence for a text file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bom {
    /// No byte order mark.
    None,
    /// UTF-8 byte order mark (`EF BB BF`).
    Utf8,
}

/// Line-ending style observed while reading a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectedLineEnding {
    /// No line-ending bytes exist in the file.
    None,
    /// Only LF line endings exist.
    Lf,
    /// Only CRLF line endings exist.
    Crlf,
    /// Both LF and CRLF line endings exist.
    Mixed,
}

/// Concrete line-ending style the next write must produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputLineEnding {
    /// Write logical lines separated by LF.
    Lf,
    /// Write logical lines separated by CRLF.
    Crlf,
}

/// Disk-oriented format metadata retained alongside the normalized editor text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFormat {
    /// M1 supported encoding; always `"utf8"`.
    pub encoding: String,
    /// Whether a UTF-8 BOM must be emitted on save.
    pub bom: Bom,
    /// Line-ending style observed when the document was opened or created.
    pub detected_line_ending: DetectedLineEnding,
    /// Concrete output line ending to use when a write is required.
    pub preferred_line_ending: OutputLineEnding,
}

/// Serializable error returned by the file commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCommandError {
    /// Stable programmatic category.
    pub code: String,
    /// Human-readable description suitable for an error dialog.
    pub message: String,
}

impl FileCommandError {
    /// Builds a contract-shaped error. Visible crate-wide so that path identity
    /// resolution can report `path_resolution` through the same error type.
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// Result of decoding file bytes into editor-ready text plus format metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedText {
    /// UTF-8 text normalized to LF separators.
    pub text: String,
    /// Detected file metadata.
    pub format: TextFormat,
}

/// Write request sent from the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
    /// Destination path.
    pub path: String,
    /// Logical text snapshot using LF separators.
    pub text: String,
    /// Output byte order mark.
    pub bom: Bom,
    /// Concrete output line ending.
    pub line_ending: OutputLineEnding,
}

/// Decodes raw file bytes into normalized text plus format metadata.
///
/// Detection order is significant: UTF-8 BOM, then UTF-16 BOM, then NUL bytes,
/// then strict UTF-8, then line endings.
pub fn decode(bytes: &[u8]) -> Result<DecodedText, FileCommandError> {
    let bom = if bytes.starts_with(&UTF8_BOM) {
        Bom::Utf8
    } else {
        Bom::None
    };

    // UTF-16 must be reported as an encoding problem, never as binary content,
    // so it is checked before the NUL scan.
    if bytes.starts_with(&UTF16_LE_BOM) || bytes.starts_with(&UTF16_BE_BOM) {
        return Err(FileCommandError::new(
            CODE_UNSUPPORTED_ENCODING,
            "UTF-16 encoded files are not supported; save the file as UTF-8 and try again.",
        ));
    }

    let payload = match bom {
        Bom::Utf8 => &bytes[UTF8_BOM.len()..],
        Bom::None => bytes,
    };

    if payload.contains(&0x00) {
        return Err(FileCommandError::new(
            CODE_UNSUPPORTED_BINARY,
            "File appears to be binary content and cannot be opened as text.",
        ));
    }

    let decoded = std::str::from_utf8(payload).map_err(|error| {
        FileCommandError::new(
            CODE_UNSUPPORTED_ENCODING,
            format!("File is not valid UTF-8 text ({error}); only UTF-8 is supported."),
        )
    })?;

    let (detected_line_ending, preferred_line_ending) = analyze_line_endings(decoded)?;

    Ok(DecodedText {
        text: decoded.replace("\r\n", "\n"),
        format: TextFormat {
            encoding: "utf8".to_string(),
            bom,
            detected_line_ending,
            preferred_line_ending,
        },
    })
}

/// Encodes logical LF text into file bytes using the requested format.
///
/// No trimming, Unicode normalization, or final-newline modification is done.
pub fn encode(text: &str, bom: &Bom, line_ending: &OutputLineEnding) -> Vec<u8> {
    let body = match line_ending {
        OutputLineEnding::Lf => text.to_string(),
        OutputLineEnding::Crlf => text.replace('\n', "\r\n"),
    };

    let mut bytes = Vec::with_capacity(body.len() + UTF8_BOM.len());
    if *bom == Bom::Utf8 {
        bytes.extend_from_slice(&UTF8_BOM);
    }
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

/// Reads and decodes a file from disk, reporting `io_read` on I/O failure.
pub fn decode_file(path: &str) -> Result<DecodedText, FileCommandError> {
    let bytes = std::fs::read(path).map_err(|error| {
        FileCommandError::new(CODE_IO_READ, format!("Failed to read '{path}': {error}"))
    })?;
    decode(&bytes)
}

/// Encodes and writes a file to disk, reporting `io_write` on I/O failure.
pub fn write_file(request: &WriteRequest) -> Result<(), FileCommandError> {
    let bytes = encode(&request.text, &request.bom, &request.line_ending);
    std::fs::write(&request.path, bytes).map_err(|error| {
        FileCommandError::new(
            CODE_IO_WRITE,
            format!("Failed to write '{}': {error}", request.path),
        )
    })
}

/// Counts CRLF and bare-LF line endings and derives the format metadata.
///
/// A `\r` that is not immediately followed by `\n` is rejected.
fn analyze_line_endings(
    text: &str,
) -> Result<(DetectedLineEnding, OutputLineEnding), FileCommandError> {
    let bytes = text.as_bytes();
    let mut crlf_count: usize = 0;
    let mut lf_count: usize = 0;
    let mut index = 0;

    while index < bytes.len() {
        match bytes[index] {
            b'\r' => {
                if bytes.get(index + 1) == Some(&b'\n') {
                    crlf_count += 1;
                    index += 2;
                } else {
                    return Err(FileCommandError::new(
                        CODE_UNSUPPORTED_LINE_ENDING,
                        "File contains a carriage return that is not part of a CRLF line ending.",
                    ));
                }
            }
            b'\n' => {
                lf_count += 1;
                index += 1;
            }
            _ => index += 1,
        }
    }

    let metadata = match (crlf_count, lf_count) {
        (0, 0) => (DetectedLineEnding::None, OutputLineEnding::Crlf),
        (0, _) => (DetectedLineEnding::Lf, OutputLineEnding::Lf),
        (_, 0) => (DetectedLineEnding::Crlf, OutputLineEnding::Crlf),
        (crlf, lf) => (
            DetectedLineEnding::Mixed,
            if crlf >= lf {
                OutputLineEnding::Crlf
            } else {
                OutputLineEnding::Lf
            },
        ),
    };

    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_ok(bytes: &[u8]) -> DecodedText {
        match decode(bytes) {
            Ok(decoded) => decoded,
            Err(error) => panic!("expected decode to succeed, got {error:?}"),
        }
    }

    fn decode_error_code(bytes: &[u8]) -> String {
        match decode(bytes) {
            Ok(decoded) => panic!("expected decode to fail, got {decoded:?}"),
            Err(error) => error.code,
        }
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("sorakada-codec-{}-{name}", std::process::id()));
        path
    }

    #[test]
    fn round_trips_utf8_bom_and_line_ending_matrix() {
        let cases = [
            (
                Bom::None,
                OutputLineEnding::Lf,
                DetectedLineEnding::Lf,
                OutputLineEnding::Lf,
            ),
            (
                Bom::None,
                OutputLineEnding::Crlf,
                DetectedLineEnding::Crlf,
                OutputLineEnding::Crlf,
            ),
            (
                Bom::Utf8,
                OutputLineEnding::Lf,
                DetectedLineEnding::Lf,
                OutputLineEnding::Lf,
            ),
            (
                Bom::Utf8,
                OutputLineEnding::Crlf,
                DetectedLineEnding::Crlf,
                OutputLineEnding::Crlf,
            ),
        ];

        for text in [
            "alpha\nbeta\ngamma",
            "alpha\nbeta\ngamma\n",
            "únïcødé ✓ 漢字\n",
        ] {
            for (bom, line_ending, detected, preferred) in cases {
                let bytes = encode(text, &bom, &line_ending);
                let decoded = decode_ok(&bytes);

                assert_eq!(
                    decoded.text, text,
                    "text mismatch for {bom:?}/{line_ending:?}"
                );
                assert_eq!(decoded.format.encoding, "utf8");
                assert_eq!(decoded.format.bom, bom);
                assert_eq!(decoded.format.detected_line_ending, detected);
                assert_eq!(decoded.format.preferred_line_ending, preferred);

                // Re-encoding the decoded text must reproduce the exact bytes.
                let re_encoded = encode(
                    &decoded.text,
                    &decoded.format.bom,
                    &decoded.format.preferred_line_ending,
                );
                assert_eq!(re_encoded, bytes);
            }
        }
    }

    #[test]
    fn encode_crlf_writes_crlf_bytes_and_lf_writes_lf_bytes() {
        assert_eq!(
            encode("a\nb", &Bom::None, &OutputLineEnding::Crlf),
            b"a\r\nb".to_vec()
        );
        assert_eq!(
            encode("a\nb\n", &Bom::None, &OutputLineEnding::Crlf),
            b"a\r\nb\r\n".to_vec()
        );
        assert_eq!(
            encode("a\nb\n", &Bom::None, &OutputLineEnding::Lf),
            b"a\nb\n".to_vec()
        );
    }

    #[test]
    fn encode_prepends_utf8_bom_only_when_requested() {
        let with_bom = encode("a\nb", &Bom::Utf8, &OutputLineEnding::Lf);
        assert_eq!(&with_bom[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(&with_bom[3..], b"a\nb");

        let without_bom = encode("a\nb", &Bom::Utf8, &OutputLineEnding::Crlf);
        assert_eq!(&without_bom[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(&without_bom[3..], b"a\r\nb");

        assert_eq!(
            encode("a\nb", &Bom::None, &OutputLineEnding::Lf),
            b"a\nb".to_vec()
        );
        assert_eq!(
            encode("a\nb", &Bom::None, &OutputLineEnding::Crlf),
            b"a\r\nb".to_vec()
        );
    }

    #[test]
    fn empty_input_decodes_to_empty_text_none_crlf() {
        let decoded = decode_ok(b"");
        assert_eq!(decoded.text, "");
        assert_eq!(decoded.format.encoding, "utf8");
        assert_eq!(decoded.format.bom, Bom::None);
        assert_eq!(
            decoded.format.detected_line_ending,
            DetectedLineEnding::None
        );
        assert_eq!(decoded.format.preferred_line_ending, OutputLineEnding::Crlf);

        assert!(encode("", &Bom::None, &OutputLineEnding::Lf).is_empty());
        assert!(encode("", &Bom::None, &OutputLineEnding::Crlf).is_empty());
        assert_eq!(
            encode("", &Bom::Utf8, &OutputLineEnding::Lf),
            vec![0xEF, 0xBB, 0xBF]
        );
    }

    #[test]
    fn bom_only_input_decodes_to_empty_text_with_utf8_bom() {
        let decoded = decode_ok(&[0xEF, 0xBB, 0xBF]);
        assert_eq!(decoded.text, "");
        assert_eq!(decoded.format.bom, Bom::Utf8);
        assert_eq!(
            decoded.format.detected_line_ending,
            DetectedLineEnding::None
        );
        assert_eq!(decoded.format.preferred_line_ending, OutputLineEnding::Crlf);

        assert_eq!(
            encode(
                &decoded.text,
                &decoded.format.bom,
                &decoded.format.preferred_line_ending
            ),
            vec![0xEF, 0xBB, 0xBF]
        );
    }

    #[test]
    fn single_line_without_eol_preserves_text() {
        let decoded = decode_ok(b"hello world");
        assert_eq!(decoded.text, "hello world");
        assert_eq!(decoded.format.bom, Bom::None);
        assert_eq!(
            decoded.format.detected_line_ending,
            DetectedLineEnding::None
        );
        assert_eq!(decoded.format.preferred_line_ending, OutputLineEnding::Crlf);
        assert_eq!(
            encode(
                &decoded.text,
                &Bom::None,
                &decoded.format.preferred_line_ending
            ),
            b"hello world".to_vec()
        );
    }

    #[test]
    fn whitespace_is_preserved_exactly_through_decode_and_encode() {
        let lf_bytes = b"  leading\ntrailing  \n\tmixed \t\n\n  ";
        let decoded = decode_ok(lf_bytes);
        assert_eq!(decoded.text, "  leading\ntrailing  \n\tmixed \t\n\n  ");
        assert_eq!(decoded.format.detected_line_ending, DetectedLineEnding::Lf);
        assert_eq!(
            encode(
                &decoded.text,
                &decoded.format.bom,
                &decoded.format.preferred_line_ending
            ),
            lf_bytes.to_vec()
        );

        let crlf_bytes = b"a  \r\n\tb \r\n";
        let decoded = decode_ok(crlf_bytes);
        assert_eq!(decoded.text, "a  \n\tb \n");
        assert_eq!(
            decoded.format.detected_line_ending,
            DetectedLineEnding::Crlf
        );
        assert_eq!(
            encode(
                &decoded.text,
                &decoded.format.bom,
                &decoded.format.preferred_line_ending
            ),
            crlf_bytes.to_vec()
        );
    }

    #[test]
    fn final_newline_is_preserved_and_never_added_or_removed() {
        assert_eq!(decode_ok(b"a\n").text, "a\n");
        assert_eq!(decode_ok(b"a").text, "a");
        assert_eq!(decode_ok(b"a\r\n").text, "a\n");
        assert_eq!(decode_ok(b"a\r\n\r\n").text, "a\n\n");

        assert_eq!(
            encode("a\n", &Bom::None, &OutputLineEnding::Lf),
            b"a\n".to_vec()
        );
        assert_eq!(
            encode("a", &Bom::None, &OutputLineEnding::Lf),
            b"a".to_vec()
        );
        assert_eq!(
            encode("a\n", &Bom::None, &OutputLineEnding::Crlf),
            b"a\r\n".to_vec()
        );
        assert_eq!(
            encode("a", &Bom::None, &OutputLineEnding::Crlf),
            b"a".to_vec()
        );
    }

    #[test]
    fn line_ending_detection_reports_lf_crlf_and_mixed() {
        let crlf = decode_ok(b"a\r\nb\r\n");
        assert_eq!(crlf.format.detected_line_ending, DetectedLineEnding::Crlf);
        assert_eq!(crlf.format.preferred_line_ending, OutputLineEnding::Crlf);
        assert_eq!(crlf.text, "a\nb\n");

        let lf = decode_ok(b"a\nb\n");
        assert_eq!(lf.format.detected_line_ending, DetectedLineEnding::Lf);
        assert_eq!(lf.format.preferred_line_ending, OutputLineEnding::Lf);
        assert_eq!(lf.text, "a\nb\n");
    }

    #[test]
    fn mixed_line_endings_prefer_the_dominant_style_and_ties_go_to_crlf() {
        let crlf_dominant = decode_ok(b"a\r\nb\nc\r\n");
        assert_eq!(
            crlf_dominant.format.detected_line_ending,
            DetectedLineEnding::Mixed
        );
        assert_eq!(
            crlf_dominant.format.preferred_line_ending,
            OutputLineEnding::Crlf
        );
        assert_eq!(crlf_dominant.text, "a\nb\nc\n");

        let tie = decode_ok(b"a\r\nb\n");
        assert_eq!(tie.format.detected_line_ending, DetectedLineEnding::Mixed);
        assert_eq!(tie.format.preferred_line_ending, OutputLineEnding::Crlf);
        assert_eq!(tie.text, "a\nb\n");

        let lf_dominant = decode_ok(b"a\nb\nc\r\n");
        assert_eq!(
            lf_dominant.format.detected_line_ending,
            DetectedLineEnding::Mixed
        );
        assert_eq!(
            lf_dominant.format.preferred_line_ending,
            OutputLineEnding::Lf
        );
        assert_eq!(lf_dominant.text, "a\nb\nc\n");
    }

    #[test]
    fn invalid_utf8_is_rejected_as_unsupported_encoding() {
        let error = decode(&[0x41, 0xC3, 0x28]).expect_err("invalid UTF-8 must fail");
        assert_eq!(error.code, CODE_UNSUPPORTED_ENCODING);
        assert!(!error.message.is_empty());

        // Invalid UTF-8 after a UTF-8 BOM must be rejected the same way.
        assert_eq!(
            decode_error_code(&[0xEF, 0xBB, 0xBF, 0x41, 0xC3, 0x28]),
            CODE_UNSUPPORTED_ENCODING
        );
        // Overlong/unpaired surrogate style lead bytes are invalid UTF-8 too.
        assert_eq!(
            decode_error_code(&[0xED, 0xA0, 0x80]),
            CODE_UNSUPPORTED_ENCODING
        );
    }

    #[test]
    fn utf16_boms_are_rejected_as_unsupported_encoding_not_binary() {
        assert_eq!(
            decode_error_code(&[0xFF, 0xFE, 0x41, 0x00]),
            CODE_UNSUPPORTED_ENCODING
        );
        assert_eq!(
            decode_error_code(&[0xFE, 0xFF, 0x00, 0x41]),
            CODE_UNSUPPORTED_ENCODING
        );
        assert_eq!(decode_error_code(&[0xFF, 0xFE]), CODE_UNSUPPORTED_ENCODING);
        assert_eq!(decode_error_code(&[0xFE, 0xFF]), CODE_UNSUPPORTED_ENCODING);

        let error = decode(&[0xFF, 0xFE, 0x41, 0x00]).expect_err("UTF-16 must fail");
        assert!(
            error.message.to_lowercase().contains("utf-16"),
            "message should mention UTF-16: {}",
            error.message
        );
    }

    #[test]
    fn nul_bytes_are_rejected_as_unsupported_binary() {
        assert_eq!(decode_error_code(b"a\0b"), CODE_UNSUPPORTED_BINARY);
        assert_eq!(decode_error_code(b"\0"), CODE_UNSUPPORTED_BINARY);
        assert_eq!(
            decode_error_code(&[0xEF, 0xBB, 0xBF, b'a', 0x00]),
            CODE_UNSUPPORTED_BINARY
        );
    }

    #[test]
    fn bare_carriage_returns_are_rejected_as_unsupported_line_ending() {
        assert_eq!(decode_error_code(b"a\rb"), CODE_UNSUPPORTED_LINE_ENDING);
        assert_eq!(decode_error_code(b"\r"), CODE_UNSUPPORTED_LINE_ENDING);
        assert_eq!(decode_error_code(b"a\r"), CODE_UNSUPPORTED_LINE_ENDING);
        assert_eq!(decode_error_code(b"a\r\r\n"), CODE_UNSUPPORTED_LINE_ENDING);
        assert_eq!(
            decode_error_code(b"a\r\nb\rc\n"),
            CODE_UNSUPPORTED_LINE_ENDING
        );
        assert_eq!(
            decode_error_code(b"a\nb\rc\r\n"),
            CODE_UNSUPPORTED_LINE_ENDING
        );
    }

    #[test]
    fn decode_file_and_write_file_round_trip_through_disk() {
        let path = temp_path("round-trip.txt");
        let path_str = path.to_string_lossy().to_string();

        let request = WriteRequest {
            path: path_str.clone(),
            text: "one\ntwo\n".to_string(),
            bom: Bom::Utf8,
            line_ending: OutputLineEnding::Crlf,
        };
        write_file(&request).expect("write should succeed");

        let expected = encode("one\ntwo\n", &Bom::Utf8, &OutputLineEnding::Crlf);
        assert_eq!(std::fs::read(&path).expect("read back"), expected);

        let decoded = decode_file(&path_str).expect("decode should succeed");
        assert_eq!(decoded.text, "one\ntwo\n");
        assert_eq!(decoded.format.bom, Bom::Utf8);
        assert_eq!(
            decoded.format.detected_line_ending,
            DetectedLineEnding::Crlf
        );
        assert_eq!(decoded.format.preferred_line_ending, OutputLineEnding::Crlf);

        std::fs::remove_file(&path).expect("cleanup");
    }

    #[test]
    fn decode_file_reports_io_read_for_missing_path() {
        let path = temp_path("missing.txt");
        let _ = std::fs::remove_file(&path);

        let error = decode_file(&path.to_string_lossy()).expect_err("missing file must fail");
        assert_eq!(error.code, CODE_IO_READ);
        assert!(!error.message.is_empty());
    }

    #[test]
    fn write_file_reports_io_write_for_invalid_destination() {
        let mut path = temp_path("nested");
        path.push("missing-directory");
        path.push("file.txt");

        let request = WriteRequest {
            path: path.to_string_lossy().to_string(),
            text: "a\n".to_string(),
            bom: Bom::None,
            line_ending: OutputLineEnding::Lf,
        };

        let error = write_file(&request).expect_err("invalid destination must fail");
        assert_eq!(error.code, CODE_IO_WRITE);
        assert!(!error.message.is_empty());
    }
}
