# Contract: Tauri File Commands

These invoke contracts are internal desktop IPC boundaries between the React application layer and Rust file layer. They deliberately expose logical text + file-format metadata rather than raw filesystem plugin access.

## Command: `read_text_file`

### Request

```ts
invoke<OpenTextFileResult>("read_text_file", {
  path: string,
});
```

### Success response

```ts
interface OpenTextFileResult {
  text: string; // normalized to LF
  format: {
    encoding: "utf8";
    bom: "none" | "utf8";
    detectedLineEnding: "none" | "lf" | "crlf" | "mixed";
    preferredLineEnding: "lf" | "crlf";
  };
}
```

### Error response

```ts
interface FileCommandError {
  code:
    | "io_read"
    | "unsupported_encoding"
    | "unsupported_binary"
    | "unsupported_line_ending";
  message: string;
}
```

### Required semantics

- UTF-8 BOM is detected and removed from returned logical text.
- UTF-16 BOM is rejected as unsupported encoding.
- Invalid UTF-8 is rejected; no lossy replacement characters are introduced.
- Obvious binary content containing NUL bytes is rejected.
- CRLF is normalized to LF in returned text.
- LF/CRLF counts determine detected/preferred EOL metadata.
- Any CR byte outside CRLF is outside M1 and rejected, including when mixed with LF or CRLF line endings.
- Command failure has no frontend document side effect; replacement happens only after a success response.

## Command: `write_text_file`

### Request

```ts
invoke<void>("write_text_file", {
  request: {
    path: string;
    text: string; // CodeMirror logical text, LF separators
    bom: "none" | "utf8";
    lineEnding: "lf" | "crlf";
  },
});
```

### Error response

```ts
interface FileCommandError {
  code: "io_write";
  message: string;
}
```

### Required semantics

- `text` is encoded as UTF-8.
- `lineEnding=crlf` converts logical LF separators to CRLF.
- `lineEnding=lf` leaves logical LF separators as LF.
- `bom=utf8` prepends `EF BB BF`; `bom=none` does not.
- No whitespace trimming, Unicode normalization, or final-newline modification is performed.
- A success response is the only signal frontend code may use to advance path/saved-baseline state.

## Frontend Save policy (outside Rust command)

The Rust write command always writes when called. The frontend decides *whether* to call it:

- normal Save, existing path, clean document → no-op; do not rewrite
- normal Save, dirty document → write captured snapshot
- Save on Untitled → Save As flow
- Save As → always write chosen destination using concrete preferred EOL

This distinction is necessary to avoid normalizing an unedited Mixed file during a no-op Save.
