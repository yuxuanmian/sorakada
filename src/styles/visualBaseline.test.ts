/**
 * The 008 visual-baseline contract audit (T010..T011, T013..T023, T028,
 * T056..T057, T080..T081, T113..T114, T127..T128).
 *
 * Aesthetic quality cannot be proven by a unit test, and 008 deliberately does
 * not add a screenshot harness. What *can* be pinned is the boundary an
 * implementation model must not quietly move: the frozen Dark token values, the
 * decorative-layer geometry that has to fit inside 007's measured Tab/Tree boxes,
 * the fixed scrollbar lane, and the scope guard that keeps 008 presentation-only.
 *
 * The audit reads stylesheets and production source as raw text. Tests,
 * specifications, documentation and comments are excluded from the forbidden-term
 * matching (T011, T151) so the audit cannot match its own assertions.
 */

import { describe, expect, it } from "vitest";

import packageJsonSource from "../../package.json?raw";
import editorConfigSource from "../editor/editorConfig.ts?raw";
import { auditCss, collectSourceFiles } from "../test-support/sourceInventory";

import editorCss from "./editor.css?raw";
import explorerCss from "./explorer.css?raw";
import globalCss from "./global.css?raw";
import shellCss from "./shell.css?raw";
import tabsCss from "./tabs.css?raw";

/* ------------------------------------------------------------------------- */
/* Read helpers                                                               */
/* ------------------------------------------------------------------------- */

/** One parsed CSS rule, with its selector list split apart. */
interface CssRule {
  /** Every selector of the rule's selector list, trimmed. */
  selectors: readonly string[];
  /** The rule body, without the surrounding braces. */
  body: string;
  /** Whether the rule sits inside a feature query. */
  gated: boolean;
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every `@supports` block span, so a gated rule can be told from a direct one. */
function supportsSpans(css: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const match of css.matchAll(/@supports[^{]*\{/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = css.length;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === "{") {
        depth += 1;
      } else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    spans.push({ start: match.index, end });
  }
  return spans;
}

/** Parses a stylesheet into rules; at-rule preludes are transparent. */
function parseRules(css: string): CssRule[] {
  const text = withoutComments(css);
  const spans = supportsSpans(text);
  const rules: CssRule[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    rules.push({
      selectors: match[1]
        .split(",")
        .map((selector) => selector.trim())
        .filter((selector) => selector.length > 0),
      body: match[2],
      gated: spans.some((span) => start > span.start && start < span.end),
    });
  }
  return rules;
}

/** Every rule whose selector list contains `selector` exactly. */
function rulesFor(css: string, selector: string): CssRule[] {
  return parseRules(css).filter((rule) => rule.selectors.includes(selector));
}

/** Normalizes a declaration value so a wrapped multi-line value still compares. */
function normalizeValue(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

/** The value declared for one custom property, whitespace-normalized. */
function declaredValue(css: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[;{\\s])${escaped}\\s*:\\s*([^;}]+)`).exec(
    withoutComments(css),
  );
  return match === null ? undefined : normalizeValue(match[1]);
}

/** Every custom-property name declared by a stylesheet. */
function declaredProperties(css: string): string[] {
  return [...withoutComments(css).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(
    (match) => match[1],
  );
}

/** One declaration's value inside a rule body. */
function bodyValue(body: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[;{\\s])${escaped}\\s*:\\s*([^;}]+)`).exec(
    body,
  );
  return match === null ? undefined : normalizeValue(match[1]);
}

/**
 * The opacity weight baked into one ambient token, as a 0..1 fraction.
 *
 * Reading it back from the stylesheet — rather than repeating the number in the
 * assertion — is what makes the contrast guard below track a future retune: a
 * heavier accent mix has to keep the chrome text legible or the audit fails.
 */
function ambientWeight(token: string): number {
  const value = declaredValue(globalCss, token) ?? "";
  const percent = /var\(--ambient-accent\)\s*(\d+)%/.exec(value)?.[1];
  expect(percent, `${token} must be a low-opacity accent mix`).toBeDefined();
  const weight = Number(percent) / 100;
  expect(weight, token).toBeGreaterThan(0);
  // A high weight is exactly the "saturated purple block" to avoid.
  expect(weight, token).toBeLessThanOrEqual(0.2);
  return weight;
}

/* ------------------------------------------------------------------------- */
/* The frozen 008 baseline (plan.md §1..§2, §4)                               */
/* ------------------------------------------------------------------------- */

/** The exact first-pass palette (T013). */
const FROZEN_PALETTE: Readonly<Record<string, string>> = {
  "--color-bg": "#1b1c1f",
  "--color-bg-raised": "#22242a",
  "--color-border": "#343740",
  "--color-text": "#e3e5e8",
  "--color-text-muted": "#aeb3ba",
  "--color-text-subtle": "#747a83",
  "--color-line-active": "#292c33",
  "--color-selection": "#3a4555",
  "--color-selection-text": "#eef1f4",
  "--color-accent": "#4a8cff",
  "--color-caret": "#82aaff",
  "--color-hover": "#272a30",
  "--color-active": "#30343c",
  "--color-focus-ring": "#4f83c5",
};

/** The exact first-pass semantic surfaces (T016). */
const FROZEN_SURFACES: Readonly<Record<string, string>> = {
  "--surface-editor": "var(--color-bg)",
  "--surface-sidebar":
    "color-mix(in srgb, var(--color-bg-raised) 94%, transparent)",
  "--surface-tab-strip":
    "color-mix(in srgb, var(--color-bg-raised) 88%, var(--color-bg))",
  "--surface-tab":
    "color-mix(in srgb, var(--color-bg-raised) 78%, var(--color-bg))",
  "--surface-tab-hover":
    "color-mix(in srgb, var(--surface-tab) 94%, var(--color-text) 6%)",
  "--surface-tab-active":
    "color-mix(in srgb, var(--surface-tab) 89%, var(--color-text) 11%)",
  "--border-tab": "color-mix(in srgb, var(--color-border) 84%, transparent)",
  "--border-tab-hover":
    "color-mix(in srgb, var(--color-border) 92%, var(--color-text) 8%)",
  "--border-tab-active":
    "color-mix(in srgb, var(--color-accent) 58%, var(--color-border))",
  "--highlight-tab": "rgb(255 255 255 / 5%)",
  "--surface-tree-hover": "color-mix(in srgb, var(--color-text) 5%, transparent)",
  "--surface-tree-selected":
    "color-mix(in srgb, var(--color-selection) 72%, var(--color-bg-raised))",
  "--color-tree-guide":
    "color-mix(in srgb, var(--color-text-muted) 13%, transparent)",
};

/** The exact first-pass scrollbar colours (T017). */
const FROZEN_SCROLLBAR_TOKENS: Readonly<Record<string, string>> = {
  "--scrollbar-thumb": "rgb(174 179 186 / 28%)",
  "--scrollbar-thumb-hover": "rgb(174 179 186 / 45%)",
  "--scrollbar-thumb-active": "rgb(174 179 186 / 62%)",
};

/* ------------------------------------------------------------------------- */
/* Scope guard (T011, T151)                                                   */
/* ------------------------------------------------------------------------- */

const FRONTEND_SOURCES = collectSourceFiles("src", [".ts", ".tsx", ".css"]);
const PRODUCTION_SOURCES = FRONTEND_SOURCES.filter(
  (file) =>
    !file.relativePath.endsWith(".test.ts") &&
    !file.relativePath.endsWith(".test.tsx"),
);

const STYLE_SHEETS = collectSourceFiles("src/styles", [".css"]);
const WRAPPER_SHEETS = collectSourceFiles("src/ui", [".css"]);
const OWNED_SHEETS = [...STYLE_SHEETS, ...WRAPPER_SHEETS];

/**
 * The three scrollers 008 restyles, with the stylesheet that owns each one.
 */
const SCROLLERS: readonly { surface: string; css: string }[] = [
  { surface: ".editor-host .cm-scroller", css: editorCss },
  { surface: ".explorer__body", css: explorerCss },
  { surface: ".tab-strip__viewport", css: tabsCss },
];

/**
 * Window-material and platform-backdrop vocabulary 008 must not introduce.
 *
 * The terms live here, in a test, which is exactly why the production scan
 * excludes tests: the audit's own literals must never count as a violation.
 */
const FORBIDDEN_PLATFORM_TERMS: readonly string[] = [
  "backdrop-filter",
  "backdropFilter",
  "-webkit-backdrop-filter",
  "window-vibrancy",
  "setEffects",
  "DWMWA_",
];

/** Dependencies the 001..007 baseline already declares (T004, T133, FR-064). */
const BASELINE_DEPENDENCIES: readonly string[] = [
  "@base-ui/react",
  "@codemirror/commands",
  "@codemirror/state",
  "@codemirror/view",
  "@tanstack/react-virtual",
  "@tauri-apps/api",
  "@tauri-apps/plugin-dialog",
  "codemirror",
  "react",
  "react-dom",
];

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const TAURI_CONFIGS = import.meta.glob<string>(
  ["/src-tauri/tauri.conf.json", "/src-tauri/capabilities/*.json"],
  { query: "?raw", import: "default", eager: true },
);

describe("008 stays inside its presentation scope (T011, T133, T151)", () => {
  it("adds no backdrop or window-material API to production source", () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const term of FORBIDDEN_PLATFORM_TERMS) {
        expect(file.text, `${file.relativePath}: ${term}`).not.toContain(term);
      }
    }
  });

  it("adds no window transparency or backdrop key to the Tauri configuration", () => {
    const entries = Object.entries(TAURI_CONFIGS);
    // The guard must actually read the configuration, not pass vacuously.
    expect(entries.map(([path]) => path)).toContain("/src-tauri/tauri.conf.json");

    for (const [path, text] of entries) {
      for (const term of ["transparent", "backdrop", "acrylic", "mica", "effects"]) {
        expect(text.toLowerCase(), `${path}: ${term}`).not.toContain(term);
      }
    }
  });

  it("declares exactly the 007 runtime dependency set", () => {
    const manifest = JSON.parse(packageJsonSource) as PackageJson;
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...BASELINE_DEPENDENCIES].sort(),
    );
  });

  it("adds no scrollbar, icon or font package", () => {
    const manifest = JSON.parse(packageJsonSource) as PackageJson;
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];
    const forbidden = declared.filter((name) =>
      /scrollbar|overlay-scroll|iconify|lucide|feather|heroicons|fontsource|jetbrains/i.test(
        name,
      ),
    );
    expect(forbidden).toEqual([]);
  });

  it("adds no freestyle embellishment to a touched stylesheet (T132)", () => {
    // 008 is a restrained baseline: no transforms, filters, blur, glow, shadows
    // or decorative animation on the surfaces it owns. `text-transform` (an
    // existing Explorer title style) and the pre-existing popup elevation token
    // are deliberately not what this looks for.
    const forbidden: readonly { name: string; pattern: RegExp }[] = [
      { name: "transform", pattern: /(?<![\w-])transform\s*:/ },
      { name: "filter", pattern: /(?<![\w-])filter\s*:/ },
      { name: "backdrop-filter", pattern: /backdrop-filter/ },
      { name: "blur", pattern: /\bblur\s*\(/ },
      { name: "animation", pattern: /(?<![\w-])animation\s*:/ },
      { name: "box-shadow", pattern: /(?<![\w-])box-shadow\s*:/ },
      { name: "scale", pattern: /(?<![\w-])scale\s*\(/ },
    ];

    for (const file of STYLE_SHEETS) {
      const text = withoutComments(file.text).toLowerCase();
      for (const { name, pattern } of forbidden) {
        expect(pattern.test(text), `${file.relativePath}: ${name}`).toBe(false);
      }
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Phase 7: no visual state in a business model (T128..T129, FR-066..FR-067)   */
/* ------------------------------------------------------------------------- */

/** The business/domain models 008 must not extend with appearance state. */
const MODEL_FILES: readonly string[] = [
  "src/app/document/documentSession.ts",
  "src/app/explorer/explorerModel.ts",
  "src/app/workspace/workContextManager.ts",
  "src/app/shell/uiPreferences.ts",
];

describe("business models gain no visual state (T128..T129)", () => {
  function modelAt(path: string) {
    return FRONTEND_SOURCES.find((file) => file.relativePath === path);
  }

  it("audits every model file it names", () => {
    for (const path of MODEL_FILES) {
      expect(modelAt(path), path).toBeDefined();
    }
  });

  it("declares no palette, font, shape or scrollbar field", () => {
    const forbidden = [
      "theme",
      "palette",
      "fontFamily",
      "fontSize",
      "lineHeight",
      "radius",
      "gradient",
      "scrollbar",
      "tabAccent",
      "hoverStyle",
      "selectionColor",
      "appearance",
    ];

    for (const path of MODEL_FILES) {
      const text = modelAt(path)!.text;
      for (const field of forbidden) {
        expect(new RegExp(`\\b${field}\\b`, "i").test(text), `${path}: ${field}`).toBe(
          false,
        );
      }
    }
  });

  it("keeps the persisted preference schema at the 007 shape", () => {
    const preferences = modelAt("src/app/shell/uiPreferences.ts")!.text;
    expect(preferences).toContain("export const UI_PREFERENCES_VERSION = 1;");
    expect(preferences).toContain(
      'export const UI_PREFERENCES_STORAGE_KEY = "sorakada.ui.preferences";',
    );

    const body =
      /export interface UiPreferences \{([\s\S]*?)\n\}/.exec(preferences)?.[1] ?? "";
    const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);
    expect(fields).toEqual([
      "version",
      "density",
      "sidebarVisible",
      "sidebarWidth",
    ]);
  });
});


/* ------------------------------------------------------------------------- */
/* The measurable half of SC-001/SC-002 (legibility and state order)          */
/* ------------------------------------------------------------------------- */

type Rgb = readonly [number, number, number];

function parseHex(value: string): Rgb {
  const hex = value.trim().replace(/^#/, "");
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance. */
function luminance(rgb: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
  );
}

/** WCAG contrast ratio, so "sufficient contrast" is a number, not an opinion. */
function contrast(left: Rgb, right: Rgb): number {
  const a = luminance(left);
  const b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `weight` of `base` mixed with the rest as `other` (a `color-mix` stand-in). */
function mix(base: Rgb, other: Rgb, weight: number): Rgb {
  return [
    Math.round(base[0] * weight + other[0] * (1 - weight)),
    Math.round(base[1] * weight + other[1] * (1 - weight)),
    Math.round(base[2] * weight + other[2] * (1 - weight)),
  ];
}

/** Composites a translucent colour over an opaque one. */
function composite(foreground: Rgb, alpha: number, background: Rgb): Rgb {
  return mix(foreground, background, alpha);
}

describe("the frozen palette stays legible and ordered (SC-001, SC-002)", () => {
  const token = (name: string): Rgb => {
    const value = declaredValue(globalCss, name);
    expect(value, name).toBeDefined();
    return parseHex(value!);
  };

  /**
   * The weight baked into one `color-mix` token, as a 0..1 fraction.
   *
   * Read back from the stylesheet rather than repeated here, so retuning a
   * derived surface is automatically re-checked against every contrast
   * assertion below instead of silently drifting past them.
   */
  const mixWeight = (name: string, source: string): number => {
    const value = declaredValue(globalCss, name) ?? "";
    const percent = new RegExp(`var\\(${source}\\)\\s*(\\d+)%`).exec(value)?.[1];
    expect(percent, `${name} must mix ${source}`).toBeDefined();
    return Number(percent) / 100;
  };

  const editorBase = token("--color-bg");
  const raised = token("--color-bg-raised");
  const text = token("--color-text");
  const muted = token("--color-text-muted");
  const subtle = token("--color-text-subtle");
  const lineActive = token("--color-line-active");
  const selection = token("--color-selection");
  const danger = token("--color-danger");

  const sidebar = mix(raised, editorBase, 0.94);
  const tabStrip = mix(raised, editorBase, 0.88);
  const tab = mix(raised, editorBase, 0.78);
  const tabHover = mix(tab, text, 0.94);
  const tabActive = mix(tab, text, 0.89);
  const currentLine = composite(lineActive, 0.72, editorBase);
  const treeSelected = mix(selection, raised, 0.72);
  const treeHover = composite(text, 0.05, sidebar);
  const guideOverBase = composite(
    muted,
    mixWeight("--color-tree-guide", "--color-text-muted"),
    editorBase,
  );

  it("keeps the Editor a softened plane and its text a softened near-white", () => {
    // FR-003/FR-004: no pure black plane, no pure white reading colour — and
    // enough contrast that "softened" never means "washed out" (SC-001).
    expect(declaredValue(globalCss, "--color-bg")).not.toMatch(/^#(000|000000)$/i);
    expect(declaredValue(globalCss, "--color-text")).not.toMatch(
      /^#(fff|ffffff)$/i,
    );
    expect(contrast(text, editorBase)).toBeGreaterThanOrEqual(7);
  });

  it("keeps every chrome foreground legible on its own surface", () => {
    for (const [name, surface] of [
      ["sidebar", sidebar],
      ["tab strip", tabStrip],
      ["tab", tab],
      // The TopBar is no longer the bare raised colour — the ambient-tinted case
      // is asserted separately below.
      ["footer", raised],
    ] as const) {
      expect(contrast(muted, surface), name).toBeGreaterThanOrEqual(4.5);
    }

    expect(contrast(text, tabHover)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, tabActive)).toBeGreaterThanOrEqual(4.5);
    // T014: the retained destructive colour is only retained if it stays
    // readable — the close control draws `--color-text` on it.
    expect(contrast(text, danger)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps ordinary line numbers quieter than the text but still perceptible", () => {
    const gutter = contrast(subtle, editorBase);
    expect(gutter).toBeGreaterThanOrEqual(2.5);
    expect(gutter).toBeLessThan(contrast(text, editorBase));
  });

  it("orders selection above current line above the editor base (SC-002)", () => {
    const base = contrast(currentLine, editorBase);
    expect(base).toBeGreaterThanOrEqual(1.05);
    expect(contrast(selection, editorBase)).toBeGreaterThan(base);
    // This compares the two *treatments* as colours — is a selection painted
    // where the current line is still tellable from the line itself? The case
    // where they actually coexist is composited below.
    expect(contrast(selection, currentLine)).toBeGreaterThanOrEqual(1.2);
  });

  it("keeps the selection distinguishable where it crosses the current line (SC-002)", () => {
    // `basicSetup` installs `drawSelection()`, and CodeMirror declares that layer
    // *below* the line elements, so the shipped stack composites the translucent
    // active line *over* the selection rather than choosing between them.
    // Measuring them as alternatives overstates the real margin: the composited
    // figure is ~1.17:1, not the ~1.53:1 the assertion above reports.
    //
    // What actually holds on screen, and is therefore asserted here, is the
    // ladder — the selected span stays strictly stronger than an unselected
    // current line, which in turn stays above the editor base, so the selection
    // is never swallowed by the current-line treatment (FR-021).
    const crossing = composite(lineActive, 0.72, selection);
    const lineOnly = currentLine;

    expect(contrast(crossing, lineOnly)).toBeGreaterThan(1.1);

    const ladder = [
      contrast(editorBase, editorBase),
      contrast(lineOnly, editorBase),
      contrast(crossing, editorBase),
      contrast(selection, editorBase),
    ];
    for (let step = 1; step < ladder.length; step += 1) {
      expect(
        ladder[step],
        `step ${step} of base < current line < selection crossing it < selection`,
      ).toBeGreaterThan(ladder[step - 1]);
    }
  });

  it("keeps the chrome foreground legible on the ambient-tinted TopBar", () => {
    // The TopBar is a translucent wash over the canvas and the ambient lifts it
    // further, so the surface the window chrome text actually sits on is neither
    // the bare raised colour nor the bare canvas. Every input is read back from the
    // stylesheet, so a heavier wash or a heavier accent has to stay legible here.
    const accent = parseHex(declaredValue(globalCss, "--ambient-accent")!);
    const canvas = parseHex(declaredValue(globalCss, "--color-canvas")!);
    const sheenWeight =
      Number(
        /(\d+)%/.exec(declaredValue(globalCss, "--chrome-sheen") ?? "")?.[1],
      ) / 100;

    const barSurface = composite(
      raised,
      mixWeight("--chrome-surface-top", "--chrome-surface"),
      canvas,
    );
    const ambientPeak = composite(
      accent,
      ambientWeight("--ambient-afterglow"),
      composite(accent, ambientWeight("--ambient-peak"), barSurface),
    );
    const tinted = composite([255, 255, 255], sheenWeight, ambientPeak);

    expect(contrast(muted, tinted)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text, tinted)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the TopBar inside the canvas field rather than its own band", () => {
    // The bar has to read as a light overlay on the work area, so it must be *no
    // more separated from the canvas than the canvas already is from the Editor
    // island*. Comparing against that existing ratio — rather than an arbitrary
    // ceiling — is what makes "the TopBar belongs to the canvas" a checkable
    // statement, and it is why both the wash and the neutral sheen have to stay
    // low: on a surface this dark, a few percent of white alone would lift the bar
    // back out of the field.
    const canvas = parseHex(declaredValue(globalCss, "--color-canvas")!);
    const editor = parseHex(declaredValue(globalCss, "--color-bg")!);
    const sheenWeight =
      Number(
        /(\d+)%/.exec(declaredValue(globalCss, "--chrome-sheen") ?? "")?.[1],
      ) / 100;

    // Worst case: the wash over the canvas, with the sheen at full strength on the
    // bar's top row.
    const bar = composite(
      raised,
      mixWeight("--chrome-surface-top", "--chrome-surface"),
      canvas,
    );
    const rendered = composite([255, 255, 255], sheenWeight, bar);

    expect(contrast(rendered, canvas)).toBeLessThan(contrast(editor, canvas));
  });

  it("orders inactive tab below hover below active", () => {
    const onStrip = (surface: Rgb): number => contrast(surface, tabStrip);
    expect(onStrip(tabHover)).toBeGreaterThan(onStrip(tab));
    expect(onStrip(tabActive)).toBeGreaterThan(onStrip(tabHover));
  });

  it("orders tree hover below tree selection", () => {
    expect(contrast(treeSelected, treeHover)).toBeGreaterThanOrEqual(1.1);
  });

  it("keeps Tree guides visible but subordinate to the label hierarchy", () => {
    const guide = contrast(guideOverBase, editorBase);
    expect(guide).toBeGreaterThanOrEqual(1.15);
    expect(guide).toBeLessThan(contrast(muted, editorBase));
  });

  it("keeps the guides fainter than the strong state fills (guide polish)", () => {
    // The guide has to stay subordinate to the selected/active fill — that is what
    // makes it read as structure rather than as decoration. It must however stay
    // *brighter* than the very weak hover tint, or hovering a row would erase the
    // skeleton. Those two requirements only meet inside this window, so the values
    // are pinned here instead of being left to taste.
    const guide = contrast(guideOverBase, editorBase);
    const selectedFill = contrast(treeSelected, editorBase);
    const hoverFill = contrast(composite(text, 0.05, editorBase), editorBase);

    expect(guide).toBeLessThan(selectedFill);
    expect(guide).toBeGreaterThan(hoverFill);
  });
});


/* ------------------------------------------------------------------------- */
/* Phase 2: shared Dark tokens (T013..T023, T028)                              */
/* ------------------------------------------------------------------------- */

describe("the central Dark token layer is frozen (T013..T021)", () => {
  it("declares every frozen palette value", () => {
    for (const [token, value] of Object.entries(FROZEN_PALETTE)) {
      expect(declaredValue(globalCss, token), token).toBe(value);
    }
  });

  it("retains the destructive colour for the first pass", () => {
    expect(declaredValue(globalCss, "--color-danger")).toBe("#b0403a");
  });

  it("declares every semantic surface with the frozen mix", () => {
    const declared = declaredProperties(globalCss);
    for (const [token, value] of Object.entries(FROZEN_SURFACES)) {
      expect(declared, token).toContain(token);
      expect(declaredValue(globalCss, token), token).toBe(value);
    }
  });

  it("declares the three scrollbar colour tokens", () => {
    for (const [token, value] of Object.entries(FROZEN_SCROLLBAR_TOKENS)) {
      expect(declaredValue(globalCss, token), token).toBe(value);
    }
  });

  it("declares the frozen Editor appearance defaults", () => {
    const families = (declaredValue(globalCss, "--font-editor") ?? "")
      .split(",")
      .map((family) => family.trim().replace(/^["']|["']$/g, ""));

    expect(families[0]).toBe("JetBrains Mono");
    expect(families).toContain("Sarasa Mono SC");
    expect(families).toContain("Noto Sans Mono CJK SC");
    expect(families).toContain("Microsoft YaHei UI");
    expect(families.indexOf("Sarasa Mono SC")).toBeLessThan(
      families.indexOf("Noto Sans Mono CJK SC"),
    );
    expect(families.indexOf("Noto Sans Mono CJK SC")).toBeLessThan(
      families.indexOf("Microsoft YaHei UI"),
    );
    expect(families.slice(-2)).toEqual(["ui-monospace", "monospace"]);

    expect(declaredValue(globalCss, "--font-size-editor")).toBe("14px");
    expect(declaredValue(globalCss, "--editor-line-height")).toBe("1.52");
    expect(declaredValue(globalCss, "--editor-padding-block")).toBe("10px");
    expect(declaredValue(globalCss, "--editor-line-padding-inline")).toBe("8px");
  });

  it("keeps the UI font and the general mono font independent of the Editor font", () => {
    const uiFont = declaredValue(globalCss, "--font-ui") ?? "";
    const monoFont = declaredValue(globalCss, "--font-mono") ?? "";
    expect(uiFont).toContain("Segoe UI Variable Text");
    expect(uiFont).not.toContain("JetBrains Mono");
    expect(monoFont).not.toContain("JetBrains Mono");
  });

  it("declares one central short-motion token", () => {
    expect(declaredValue(globalCss, "--motion-fast")).toBe("120ms");
  });

  it("adds no theme selector, theme storage key or Light palette (T028)", () => {
    for (const file of OWNED_SHEETS) {
      expect(file.text, file.relativePath).not.toContain("[data-theme");
      expect(file.text, file.relativePath).not.toContain("data-theme=");
      expect(file.text, file.relativePath).not.toContain("prefers-color-scheme");
    }
  });
});

describe("the 007 palette centralisation still holds (T022..T023, T127)", () => {
  it("declares no palette literal outside the central token layer", () => {
    const findings = auditCss(OWNED_SHEETS, {
      tokenFiles: ["src/styles/global.css"],
    }).filter((finding) => finding.rule.startsWith("palette-literal"));
    expect(findings).toEqual([]);
  });

  it("introduces no pure black or pure white in a component stylesheet", () => {
    const pureValues = /#(?:000|000000|fff|ffffff)\b/i;
    for (const file of OWNED_SHEETS) {
      if (file.relativePath === "src/styles/global.css") {
        continue;
      }
      expect(pureValues.test(file.text), file.relativePath).toBe(false);
    }
  });

  it("routes every 008 surface through the semantic tokens", () => {
    expect(bodyValue(rulesFor(shellCss, ".sidebar")[0].body, "background-color")).toBe(
      "var(--surface-sidebar)",
    );
    expect(
      bodyValue(rulesFor(tabsCss, ".tab-strip")[0].body, "background-color"),
    ).toBe("var(--surface-tab-strip)");
  });

  it("declares the island layout tokens centrally (Visual Polish)", () => {
    expect(declaredValue(globalCss, "--color-canvas")).toBe("#121317");
    expect(declaredValue(globalCss, "--surface-canvas")).toBe(
      "var(--color-canvas)",
    );
    expect(declaredValue(globalCss, "--border-island")).toBe(
      "color-mix(in srgb, var(--color-border) 70%, transparent)",
    );
    // The inset is an alias, not a second number: that is what keeps the window
    // inset and the inter-island gap equal at every density.
    expect(declaredValue(globalCss, "--island-inset")).toBe("var(--island-gap)");
    // The top inset is deliberately smaller, but must stay a real gap so the
    // islands are never flush against the unseparated chrome.
    expect(declaredValue(globalCss, "--island-inset-top")).toBe(
      "calc(var(--island-gap) / 2)",
    );
  });

  it("keeps the canvas a light step below every work surface", () => {
    // The canvas only ever shows as the inset and the gap, so it must read as a
    // slightly deeper field — not as a second reading plane.
    const canvas = parseHex(declaredValue(globalCss, "--color-canvas")!);
    const darkestSurface = parseHex(declaredValue(globalCss, "--color-bg")!);
    expect(luminance(canvas)).toBeLessThan(luminance(darkestSurface));
    expect(contrast(canvas, darkestSurface)).toBeLessThan(1.25);
  });

  it("draws the two work regions as islands on that canvas", () => {
    const mainArea = rulesFor(shellCss, ".app__main-area")[0].body;
    expect(bodyValue(mainArea, "background-color")).toBe("var(--surface-canvas)");
    // Smaller on top, uniform elsewhere: the islands tuck under the chrome.
    expect(bodyValue(mainArea, "padding")).toBe(
      "var(--island-inset-top) var(--island-inset) var(--island-inset)",
    );
    expect(bodyValue(mainArea, "gap")).toBe("var(--island-gap)");

    for (const selector of [".sidebar", ".editor-workspace"] as const) {
      const body = rulesFor(shellCss, selector)[0].body;
      expect(bodyValue(body, "border"), selector).toBe(
        "1px solid var(--border-island)",
      );
      expect(bodyValue(body, "border-radius"), selector).toBe(
        "var(--radius-island)",
      );
    }

    // The full-height divider the gap replaced must be gone.
    expect(rulesFor(shellCss, ".sidebar")[0].body).not.toContain("border-right");
  });

  it("leaves the chrome unseparated so the islands' borders are the boundary", () => {
    // A full-width line across the TopBar both competed with the islands' rim
    // borders and cut the ambient light's vertical continuity.
    const topBar = rulesFor(shellCss, ".top-bar")[0].body;
    expect(topBar).not.toContain("border");
    // The bar's surface is the translucent overlay token, not an opaque band, so the
    // canvas carries most of its colour and the ambient supplies the presence.
    expect(bodyValue(topBar, "background-color")).toBe(
      "var(--chrome-surface-top)",
    );
    // The Footer keeps its own opaque surface and separator; it is the only
    // `--chrome-border` use left.
    const footer = rulesFor(shellCss, ".footer-bar")[0].body;
    expect(bodyValue(footer, "background-color")).toBe("var(--chrome-surface)");
    expect(bodyValue(footer, "border-top")).toBe(
      "1px solid var(--chrome-border)",
    );
  });

  it("keeps TabStrip and EditorHost one island surface (Visual Polish)", () => {    // The strip is the top band of the Editor island. A hard divider there would
    // split one work surface into two stacked cards, which is exactly what the
    // island layout exists to avoid.
    expect(rulesFor(tabsCss, ".tab-strip")[0].body).not.toContain("border-bottom");

    const workspace = rulesFor(shellCss, ".editor-workspace")[0].body;
    expect(bodyValue(workspace, "background-color")).toBe(
      "var(--surface-editor)",
    );
  });

  it("builds the top chrome ambient from one shared low-opacity definition", () => {
    // One accent, only ever used through low-opacity mixes: presence has to come
    // from area and gradient length, not from saturation.
    expect(declaredValue(globalCss, "--ambient-accent")).toBe("#9b75e8");
    expect(declaredValue(globalCss, "--ambient-height")).toBe("128px");
    expect(ambientWeight("--ambient-peak")).toBeGreaterThanOrEqual(
      ambientWeight("--ambient-plateau"),
    );
    expect(ambientWeight("--ambient-plateau")).toBeGreaterThan(
      ambientWeight("--ambient-mid"),
    );
    expect(ambientWeight("--ambient-mid")).toBeGreaterThanOrEqual(
      ambientWeight("--ambient-afterglow"),
    );

    // A flat, wide ellipse whose centre sits right of the window corner, so the
    // bright area is a plateau across the bar rather than a spot in the corner.
    const radial = declaredValue(globalCss, "--ambient-radial") ?? "";
    expect(radial).toContain("46% var(--ambient-height) at 12% 0%");
    // The plateau holds the bright mid-tone out to about 30% of the width and the
    // weak stop carries it to about 45%, before the final stop reaches zero at
    // roughly 58% — about three quarters of the reach of the first pass.
    expect(radial).toContain("var(--ambient-plateau) 40%");
    expect(radial).toContain("var(--ambient-mid) 68%");
    expect(radial).toContain("transparent 100%");

    // The TopBar's extra layer is a second ellipse, not a linear wash: it is sized
    // to the bar's own band so it is already zero on the seam, which is what keeps
    // the light from ending in a visible cut once the separator is gone.
    const halo = declaredValue(globalCss, "--ambient-halo") ?? "";
    expect(halo).toContain("46% 100% at 12% 0%");
    expect(halo).toContain("var(--ambient-afterglow)");
    expect(halo).toContain("transparent 100%");

    expect(declaredValue(globalCss, "--chrome-ambient")).toBe(
      "var(--ambient-radial), var(--ambient-halo)",
    );

    // The TopBar's "lit glass" cue must stay neutral: it may not smuggle in a
    // second, stronger shot of the accent.
    const sheen = declaredValue(globalCss, "--chrome-sheen") ?? "";
    expect(sheen).toMatch(/^rgb\(255 255 255 \/ \d+%\)$/);
    expect(Number(/(\d+)%/.exec(sheen)?.[1])).toBeLessThanOrEqual(6);
  });

  it("puts the ambient behind the work islands, never on them", () => {
    // The TopBar takes the neutral sheen plus both ambient layers, anchored to
    // the same viewport field the canvas below continues; the canvas takes the
    // radial alone, and the radial reaches zero at `--ambient-height`, so nothing
    // lower is tinted.
    const topBar = rulesFor(shellCss, ".top-bar")[0].body;
    expect(bodyValue(topBar, "background-image")).toBe(
      "linear-gradient(to bottom, var(--chrome-sheen), transparent), var(--chrome-ambient)",
    );
    expect(bodyValue(topBar, "background-size")).toBe(
      "100% 100%, 100% var(--ambient-height), 100% var(--topbar-height)",
    );

    const mainArea = rulesFor(shellCss, ".app__main-area")[0].body;
    expect(bodyValue(mainArea, "background-image")).toBe("var(--ambient-radial)");
    expect(bodyValue(mainArea, "background-size")).toBe(
      "100% var(--ambient-height)",
    );
    // Shifted by the TopBar's height so the two bands line up across the seam.
    expect(bodyValue(mainArea, "background-position")).toBe(
      "0 calc(-1 * var(--topbar-height))",
    );

    // The islands stay opaque planes, so the Editor is never dyed and the
    // Explorer cannot become a purple-black theme.
    for (const selector of [".sidebar", ".editor-workspace"] as const) {
      const body = rulesFor(shellCss, selector)[0].body;
      expect(body, selector).not.toContain("background-image");
      expect(bodyValue(body, "background-color"), selector).not.toContain(
        "ambient",
      );
    }
  });

  it("adds no glow, blur or coloured shadow to the ambient chrome", () => {
    for (const selector of [
      ".top-bar",
      ".app__main-area",
      ".footer-bar",
    ] as const) {
      const body = rulesFor(shellCss, selector)[0].body;
      for (const banned of [
        "filter",
        "backdrop-filter",
        "box-shadow",
        "text-shadow",
      ] as const) {
        expect(body, `${selector} declares ${banned}`).not.toContain(banned);
      }
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Phase 4: framed Tabs (T056..T057)                                          */
/* ------------------------------------------------------------------------- */

describe("Tab frames stay inside the 007 measured box (T056..T057)", () => {
  it("draws one decorative frame layer", () => {
    const frames = rulesFor(tabsCss, ".tab::before");
    expect(frames).toHaveLength(1);

    const body = frames[0].body;
    expect(bodyValue(body, "position")).toBe("absolute");
    expect(bodyValue(body, "inset")).toBe("2px 1px 1px");
    expect(bodyValue(body, "border")).toBe("1px solid var(--border-tab)");
    expect(bodyValue(body, "border-radius")).toBe("var(--radius-md)");
    expect(bodyValue(body, "pointer-events")).toBe("none");
    expect(body).toContain("var(--surface-tab)");
  });

  it("keeps the logical Tab box free of a direct background or separator", () => {
    const tabs = rulesFor(tabsCss, ".tab");
    expect(tabs).toHaveLength(1);

    const body = tabs[0].body;
    expect(bodyValue(body, "position")).toBe("relative");
    expect(bodyValue(body, "background")).toBe("transparent");
    expect(body).not.toContain("border-right");
    expect(body).not.toContain("margin");
  });

  it("uses the hover and active frame tokens", () => {
    const hover = rulesFor(tabsCss, ".tab:hover::before")[0].body;
    expect(hover).toContain("var(--surface-tab-hover)");
    expect(hover).toContain("var(--border-tab-hover)");

    const active = rulesFor(tabsCss, ".tab--active::before")[0].body;
    expect(active).toContain("var(--surface-tab-active)");
    expect(active).toContain("var(--border-tab-active)");
    expect(active).toContain("var(--highlight-tab)");
  });

  it("animates only the frame property that can actually animate", () => {
    // The frame fill is the `background-image` gradient below, and Chromium
    // switches between gradients discretely instead of interpolating them (probed
    // in headless Chromium), so transitioning `background-color` would animate
    // only the sliver visible through the gradient's translucent top while the
    // frame's real fill snapped. Plan §15 permits a state change without
    // animation; only the border is transitioned (T076).
    const transition = bodyValue(
      rulesFor(tabsCss, ".tab::before")[0].body,
      "transition",
    );
    expect(transition).toContain("border-color var(--motion-fast)");
    expect(transition).not.toContain("background-color");
    expect(transition).not.toContain("background-image");
  });

  it("never measures horizontal Tab margins or a document viewport gap", () => {
    // `tabLayout.ts` sums the widths it assigns; a margin or gap the solver
    // cannot see is exactly what would break every offset and reveal offset.
    const tabs = rulesFor(tabsCss, ".tab")[0].body;
    expect(tabs).not.toContain("margin");

    const viewport = rulesFor(tabsCss, ".tab-strip__viewport")[0].body;
    expect(viewport).not.toContain("gap");
  });

  it("keeps the 18px close hit box and its hover surface tokenized", () => {
    const close = rulesFor(tabsCss, ".tab__close")[0].body;
    expect(bodyValue(close, "width")).toBe("18px");
    expect(bodyValue(close, "height")).toBe("18px");
    expect(rulesFor(tabsCss, ".tab__close:hover")[0].body).toContain("var(--color-");
  });

  it("gives the fixed New/Overview actions the small-radius hover language", () => {
    // Plan §8: the fixed actions stay controls rather than fake document Tabs and
    // share the same palette and small-radius hover surface as the close control.
    const action = rulesFor(tabsCss, ".tab-strip__action")[0].body;
    expect(bodyValue(action, "border-radius")).toBe("var(--radius-sm)");
    // The radius is paint-only: the measured hit geometry must not move.
    expect(bodyValue(action, "width")).toBe("var(--control-height)");
    expect(bodyValue(action, "height")).toBe("100%");
  });
});

/* ------------------------------------------------------------------------- */
/* Phase 5: Explorer feedback surface (T080..T081)                            */
/* ------------------------------------------------------------------------- */

describe("Explorer feedback is depth-independent (T080..T081)", () => {
  it("draws one decorative feedback layer with a constant inset", () => {
    const feedback = rulesFor(explorerCss, ".explorer-row::before");
    expect(feedback).toHaveLength(1);

    const body = feedback[0].body;
    expect(bodyValue(body, "position")).toBe("absolute");
    expect(bodyValue(body, "top")).toBe("1px");
    expect(bodyValue(body, "bottom")).toBe("1px");
    expect(bodyValue(body, "left")).toBe("calc(var(--tree-indent) / 2 + 1px)");
    expect(bodyValue(body, "right")).toBe("calc(var(--tree-indent) / 2 + 1px)");
    expect(bodyValue(body, "border-radius")).toBe("var(--radius-md)");
    expect(bodyValue(body, "pointer-events")).toBe("none");
  });

  it("never derives the feedback geometry from row depth", () => {
    const row = rulesFor(explorerCss, ".explorer-row")[0].body;
    expect(row).not.toContain("depth");
    expect(rulesFor(explorerCss, ".explorer-row::before")[0].body).not.toContain(
      "depth",
    );
  });

  it("keeps the row box itself transparent so feedback paints on the layer", () => {
    const row = rulesFor(explorerCss, ".explorer-row")[0].body;
    expect(bodyValue(row, "position")).toBe("relative");
    expect(bodyValue(row, "background")).toBe("transparent");
    expect(bodyValue(row, "isolation")).toBe("isolate");
    expect(bodyValue(row, "height")).toBe("var(--tree-row-height)");
  });

  it("moves hover and selection colour onto the feedback layer", () => {
    for (const selector of [
      ".explorer-row:hover",
      ".explorer-row--selected",
      ".explorer-row--selected:hover",
    ]) {
      for (const rule of rulesFor(explorerCss, selector)) {
        expect(rule.body, selector).not.toContain("background-color");
        expect(rule.body, selector).not.toContain("background:");
      }
    }

    expect(
      bodyValue(rulesFor(explorerCss, ".explorer-row:hover::before")[0].body, "background-color"),
    ).toBe("var(--surface-tree-hover)");
    expect(
      bodyValue(
        rulesFor(explorerCss, ".explorer-row--selected::before")[0].body,
        "background-color",
      ),
    ).toBe("var(--surface-tree-selected)");
  });

  it("draws one purely vertical guide per ancestor level", () => {
    const guide = rulesFor(explorerCss, ".explorer-row__guide::before")[0].body;
    expect(bodyValue(guide, "width")).toBe("1px");
    // Full height, so the rows of one subtree tile into a single unbroken line.
    expect(bodyValue(guide, "top")).toBe("0");
    expect(bodyValue(guide, "bottom")).toBe("0");
    expect(bodyValue(guide, "background-color")).toBe("var(--color-tree-guide)");
  });

  it("keeps every guide vertical: no connectors and no per-level ending", () => {
    // The design is one straight line per ancestor level. A horizontal `::after`
    // stub, a half-height stop or a hidden level would each bring back the
    // elbow/broken-line look this pass removes, so their absence is the contract.
    const selectors = parseRules(explorerCss).flatMap((rule) => rule.selectors);
    for (const banned of ["--gap", "--stop", "--stub", "--elbow", "--branch"]) {
      expect(
        selectors.filter((selector) => selector.includes(banned)),
        `${banned} must not exist`,
      ).toEqual([]);
    }

    // No second pseudo-element on a guide, and none on the chevron either.
    expect(
      selectors.filter(
        (selector) =>
          selector.includes("explorer-row__guide") &&
          selector.includes("::after"),
      ),
    ).toEqual([]);
    expect(
      selectors.filter(
        (selector) =>
          selector.includes("explorer-row__chevron") &&
          selector.includes("::after"),
      ),
    ).toEqual([]);
  });

  it("keeps the guides above the hover and selection fills", () => {
    // The line must pass through a hovered or selected row rather than being
    // painted over by it: the slots are positioned row children.
    expect(
      bodyValue(rulesFor(explorerCss, ".explorer-row > *")[0].body, "position"),
    ).toBe("relative");
  });

  it("keeps the inline editor a visible control at the row-relative height", () => {
    const input = rulesFor(explorerCss, ".explorer-inline-input")[0].body;
    expect(bodyValue(input, "height")).toBe("calc(var(--tree-row-height) - 4px)");
    expect(bodyValue(input, "border")).toBe("1px solid var(--color-focus-ring)");
    expect(bodyValue(input, "border-radius")).toBe("var(--radius-md)");
    expect(bodyValue(input, "background-color")).toBe("var(--surface-editor)");
    expect(bodyValue(input, "color")).toBe("var(--color-text)");
  });
});

/* ------------------------------------------------------------------------- */
/* State changes are paint-only (T076, T087)                                  */
/* ------------------------------------------------------------------------- */

describe("no 008 state change touches geometry (T076, T087)", () => {
  const PAINT_PROPERTIES =
    /^(background|background-color|background-image|border|border-color|border-width|border-radius|color|transition|opacity|outline|outline-offset)$/;

  const STATEFUL_SELECTORS: readonly string[] = [
    ".tab:hover",
    ".tab:hover::before",
    ".tab--active",
    ".tab--active::before",
    ".tab__close:hover",
    ".tab-strip__action:hover",
    ".tab-strip__action[data-popup-open]",
    ".explorer-row:hover",
    ".explorer-row:hover::before",
    ".explorer-row--selected",
    ".explorer-row--selected:hover",
    ".explorer-row--selected::before",
    ".explorer-row--selected:hover::before",
  ];

  it("declares only paint properties in a hover or active rule", () => {
    // Hover/active styling may change surface, border and text colour — never
    // width, height, padding, margin, positioning or a transform. That is what
    // keeps Tab labels, close controls and recycled Tree rows pixel-stable.
    for (const [name, css] of [
      ["tabs.css", tabsCss],
      ["explorer.css", explorerCss],
    ] as const) {
      for (const rule of parseRules(css)) {
        const stateful = rule.selectors.some((selector) =>
          STATEFUL_SELECTORS.includes(selector),
        );
        if (!stateful) {
          continue;
        }

        for (const declaration of rule.body.split(";")) {
          const property = declaration.split(":")[0]?.trim() ?? "";
          if (property.length === 0) {
            continue;
          }
          expect(
            PAINT_PROPERTIES.test(property),
            `${name} ${rule.selectors.join(", ")}: ${property}`,
          ).toBe(true);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Phase 6: the fixed scrollbar lane (T113..T114)                             */
/* ------------------------------------------------------------------------- */

describe("the scrollbar lane never changes width (T113..T114)", () => {
  for (const scroller of SCROLLERS) {
    it(`${scroller.surface} reserves one fixed 12px lane`, () => {
      const lane = rulesFor(scroller.css, `${scroller.surface}::-webkit-scrollbar`);
      expect(lane).toHaveLength(1);
      expect(bodyValue(lane[0].body, "width")).toBe("12px");
      expect(bodyValue(lane[0].body, "height")).toBe("12px");
    });

    it(`${scroller.surface} keeps the track and corner transparent`, () => {
      expect(
        bodyValue(
          rulesFor(scroller.css, `${scroller.surface}::-webkit-scrollbar-track`)[0]
            .body,
          "background",
        ),
      ).toBe("transparent");
      expect(
        bodyValue(
          rulesFor(scroller.css, `${scroller.surface}::-webkit-scrollbar-corner`)[0]
            .body,
          "background",
        ),
      ).toBe("transparent");
    });

    it(`${scroller.surface} draws a ~6px idle thumb inside the 12px lane`, () => {
      const thumb = rulesFor(
        scroller.css,
        `${scroller.surface}::-webkit-scrollbar-thumb`,
      )[0].body;
      expect(bodyValue(thumb, "background-color")).toBe("var(--scrollbar-thumb)");
      expect(bodyValue(thumb, "background-clip")).toBe("content-box");
      expect(bodyValue(thumb, "border")).toBe("3px solid transparent");
      expect(bodyValue(thumb, "border-radius")).toBe("999px");
    });

    it(`${scroller.surface} grows to ~8px and brightens on hover and drag`, () => {
      const hover = rulesFor(
        scroller.css,
        `${scroller.surface}::-webkit-scrollbar-thumb:hover`,
      )[0].body;
      expect(bodyValue(hover, "background-color")).toBe(
        "var(--scrollbar-thumb-hover)",
      );
      expect(bodyValue(hover, "border-width")).toBe("2px");

      const active = rulesFor(
        scroller.css,
        `${scroller.surface}::-webkit-scrollbar-thumb:active`,
      )[0].body;
      expect(bodyValue(active, "background-color")).toBe(
        "var(--scrollbar-thumb-active)",
      );
      expect(bodyValue(active, "border-width")).toBe("2px");
    });

    it(`${scroller.surface} keeps a standards fallback for browser-only development`, () => {
      // The fallback is gated: Chromium ignores the WebKit pseudo-elements as
      // soon as a standard scrollbar property is set on the element, so the
      // fallback may only apply where full WebKit styling is unavailable.
      const selector = scroller.surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const fallback = new RegExp(
        "@supports not selector\\(::-webkit-scrollbar\\)\\s*\\{[\\s\\S]*?" +
          `${selector}[\\s\\S]*?scrollbar-width:\\s*thin[\\s\\S]*?` +
          "scrollbar-color:\\s*var\\(--scrollbar-thumb\\)\\s+transparent[\\s\\S]*?\\n\\}",
      );
      expect(fallback.test(scroller.css)).toBe(true);
    });
  }

  it("gates every standard scrollbar property behind the feature query", () => {
    for (const scroller of SCROLLERS) {
      const direct = rulesFor(scroller.css, scroller.surface).filter(
        (rule) => !rule.gated,
      );
      for (const rule of direct) {
        expect(rule.body, scroller.surface).not.toContain("scrollbar-width");
        expect(rule.body, scroller.surface).not.toContain("scrollbar-color");
      }
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Phase 3: Editor appearance seam (T035..T036, T043, T046, T050)             */
/* ------------------------------------------------------------------------- */

describe("the Editor consumes the application appearance tokens (T035..T050)", () => {
  it("reads every typography default from the central tokens", () => {
    for (const token of [
      "--font-editor",
      "--font-size-editor",
      "--editor-line-height",
      "--editor-padding-block",
      "--editor-line-padding-inline",
    ]) {
      expect(editorConfigSource, token).toContain(`var(${token})`);
    }
    expect(editorConfigSource).not.toContain('lineHeight: "1.6"');
    expect(editorConfigSource).not.toContain('padding: "8px 0"');
  });

  it("keeps the application-scoped appearance reconfiguration seam", () => {
    expect(editorConfigSource).toContain("new Compartment()");
    expect(editorConfigSource).toContain("function appearanceBoundary()");
    expect(editorConfigSource).toContain("export function reconfigureAppearance(");
    expect(editorConfigSource).toContain("appearanceCompartment.reconfigure(");
  });

  it("styles the current line from the active-line family only", () => {
    expect(editorConfigSource).toContain(
      "color-mix(in srgb, var(--color-line-active) 72%, transparent)",
    );
    const activeLine = editorConfigSource.slice(
      editorConfigSource.indexOf('".cm-activeLine":'),
      editorConfigSource.indexOf('".cm-activeLineGutter":'),
    );
    expect(activeLine).toContain("--color-line-active");

    const activeGutter = editorConfigSource.slice(
      editorConfigSource.indexOf('".cm-activeLineGutter":'),
      editorConfigSource.indexOf("// basicSetup installs `drawSelection()`"),
    );
    expect(activeGutter).toContain("--color-line-active");
    expect(activeGutter).toContain("--color-text");
  });

  it("keeps the drawn and the native selection on the semantic selection token", () => {
    expect(editorConfigSource).toContain(".cm-selectionBackground");
    expect(editorConfigSource).toContain('"&.cm-editor .cm-selectionBackground"');
    expect(editorConfigSource).toContain("--color-selection-text");
    expect(editorConfigSource.match(/var\(--color-selection\)/g)?.length ?? 0).toBeGreaterThan(
      1,
    );
  });

  it("adds no language, highlighter or semantic-gutter concept", () => {
    const editorOwned = `${editorConfigSource}\n${editorCss}`.toLowerCase();
    for (const term of [
      "indent-guide",
      "indentguide",
      "minimap",
      "ruler",
      "breakpoint",
      "diagnostic",
      "syntaxhighlight",
      "highlightstyle",
      "@codemirror/language",
      "lezer",
    ]) {
      expect(editorOwned, term).not.toContain(term);
    }
  });

  it("keeps the caret crisp and the editor outline free of a focus box", () => {
    expect(editorConfigSource).toContain('borderLeftWidth: "2px"');
    expect(editorConfigSource).toContain('"&.cm-focused": {');
    expect(editorConfigSource).toContain('outline: "none"');
  });
});
