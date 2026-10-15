import { describe, expect, it } from "vitest";
import { i18n, resources } from "./index";

function entries(value: object, prefix = ""): [string, string][] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [[path, child]] : entries(child, path);
  });
}

describe("bundled translations", () => {
  it("starts in Simplified Chinese with English fallback", () => {
    expect(i18n.language).toBe("zh-CN");
    expect(i18n.options.fallbackLng).toEqual(["en-US"]);
  });
  it("has matching nonempty keys and interpolation parameters", () => {
    const zh = entries(resources["zh-CN"].translation);
    const en = new Map(entries(resources["en-US"].translation));
    expect(zh.map(([key]) => key).sort()).toEqual([...en.keys()].sort());
    for (const [key, text] of zh) {
      const english = en.get(key)!;
      expect(text.trim(), key).not.toBe("");
      expect(english.trim(), key).not.toBe("");
      const params = (s: string) => [...s.matchAll(/{{\s*([^}]+)\s*}}/g)].map(m => m[1].trim()).sort();
      expect(params(text), key).toEqual(params(english));
    }
  });
});
