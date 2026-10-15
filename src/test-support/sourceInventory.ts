/**
 * Source-scanning helpers for the 007 static contract audits (T017, T033, T194,
 * T195).
 *
 * Several 007 requirements are properties of the *source* rather than of runtime
 * behaviour: the dependency boundary, the CSS contract, palette centralisation.
 * They are checked by reading the repository from a Vitest test, and these
 * helpers keep that scanning in one place.
 *
 * Files are read through Vite's `import.meta.glob` rather than `node:fs`, so the
 * audit uses the same module graph the application is built from and needs no
 * Node type surface in the frontend tsconfig.
 */

/** One source file, with its repository-relative path. */
export interface SourceFile {
  /** Path relative to the repository root, always with `/` separators. */
  relativePath: string;
  /** The file's text. */
  text: string;
}

/** `.ts`/`.tsx` plus CSS is what every 007 audit needs. */
export const AUDITED_EXTENSIONS = [".ts", ".tsx", ".css"] as const;

const SOURCE_MODULES = import.meta.glob<string>("/src/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const ALL_SOURCE_FILES: readonly SourceFile[] = Object.entries(
  SOURCE_MODULES,
).map(([path, text]) => ({
  relativePath: path.replace(/^\//, ""),
  text,
}));

/**
 * Every application source file under `prefix` with one of `extensions`.
 *
 * `prefix` is a repository-relative path such as `src/styles`, so an audit can
 * scope itself to the files it owns without enumerating directories itself.
 */
export function collectSourceFiles(
  prefix: string,
  extensions: readonly string[] = AUDITED_EXTENSIONS,
): SourceFile[] {
  const normalized = prefix.replace(/\/+$/, "");
  return ALL_SOURCE_FILES.filter(
    (file) =>
      (file.relativePath === normalized ||
        file.relativePath.startsWith(`${normalized}/`)) &&
      extensions.some((extension) => file.relativePath.endsWith(extension)),
  );
}

/** One import of a specifier that the boundary rules care about. */
export interface ImportMatch {
  /** Repository-relative path of the importing file. */
  file: string;
  /** The imported specifier, without quotes. */
  specifier: string;
}

/**
 * Finds every static, dynamic or `require()` import of `packageName`.
 *
 * Matching on the *statement* rather than on the bare string keeps a test that
 * merely mentions a package name from counting as an import of it.
 */
export function findPackageImports(
  files: readonly SourceFile[],
  packageName: string,
): ImportMatch[] {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)["'](${escaped}(?:/[^"']*)?)["']`,
    "g",
  );

  const matches: ImportMatch[] = [];
  for (const file of files) {
    for (const match of file.text.matchAll(pattern)) {
      matches.push({ file: file.relativePath, specifier: match[1] });
    }
  }
  return matches;
}

/** One CSS finding. */
export interface CssFinding {
  /** Repository-relative path of the offending file. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The rule that was violated. */
  rule: string;
  /** The offending text, trimmed. */
  text: string;
}

/** The CSS contract rules (FR-017..FR-019, T033, T159, T194). */
export interface CssAuditRules {
  /**
   * Files allowed to declare palette literals and raw z-index values.
   *
   * Only the central token layer qualifies; a component style file never does.
   */
  tokenFiles: readonly string[];
  /** Files allowed to use viewport-relative dimensions; none in 007. */
  viewportUnitFiles?: readonly string[];
}

const PALETTE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "hex-colour", pattern: /#[0-9a-fA-F]{3,8}\b/ },
  { name: "rgb-colour", pattern: /\brgba?\s*\(/ },
  { name: "hsl-colour", pattern: /\bhsla?\s*\(/ },
];

/**
 * Audits stylesheets against the 007 CSS contract.
 *
 * The rules are exactly the ones the specification names: no `!important`, no
 * deep-selector escape hatch, no selector into a dependency's internals, no
 * component-local palette, no raw `z-index` outside the layer tokens, and no
 * viewport-unit sizing of basic controls.
 */
export function auditCss(
  files: readonly SourceFile[],
  rules: CssAuditRules,
): CssFinding[] {
  const findings: CssFinding[] = [];
  const tokenFiles = new Set(rules.tokenFiles);
  const viewportFiles = new Set(rules.viewportUnitFiles ?? []);

  for (const file of files) {
    const isTokenFile = tokenFiles.has(file.relativePath);
    const lines = file.text.split(/\r?\n/);

    lines.forEach((text, index) => {
      const line = index + 1;
      const record = (rule: string): void => {
        findings.push({ file: file.relativePath, line, rule, text: text.trim() });
      };

      if (text.includes("!important")) {
        record("important");
      }
      if (text.includes(":deep(")) {
        record("deep-selector");
      }
      if (/base-ui/i.test(text)) {
        record("dependency-internal-selector");
      }
      if (!isTokenFile) {
        for (const { name, pattern } of PALETTE_PATTERNS) {
          if (pattern.test(text)) {
            record(`palette-literal:${name}`);
          }
        }
        if (/\bz-index:\s*(?!\s*var\()/.test(text)) {
          record("raw-z-index");
        }
      }
      if (!isTokenFile && !viewportFiles.has(file.relativePath)) {
        if (/\b\d+(?:\.\d+)?(?:vw|vh|vmin|vmax)\b/.test(text)) {
          record("viewport-unit");
        }
      }
    });
  }

  return findings;
}
