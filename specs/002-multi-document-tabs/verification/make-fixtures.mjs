/**
 * Creates the quickstart §1 test fixtures.
 *
 * Everything lands in ./fixtures, which is disposable: re-running replaces it.
 *
 * Usage:  node make-fixtures.mjs
 */

import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

const LARGE_BYTES = 24 * 1024 * 1024; // inside the 20-50 MB SC-005 window

async function main() {
  await mkdir(FIXTURES, { recursive: true });
  await mkdir(join(FIXTURES, "a-folder"), { recursive: true });

  // ~10 KB UTF-8, LF.
  const small = Array.from(
    { length: 320 },
    (_, index) => `small line ${index + 1} — lorem ipsum dolor sit amet`,
  ).join("\n");
  await writeFile(join(FIXTURES, "small-a.txt"), `${small}\n`, "utf8");
  await writeFile(
    join(FIXTURES, "small-b.txt"),
    `${small.replace("small line", "SMALL-B line")}\n`,
    "utf8",
  );

  // UTF-8 BOM + CRLF, for the byte-identity save regression.
  const bomCrlf = Array.from(
    { length: 40 },
    (_, index) => `bom line ${index + 1}`,
  ).join("\r\n");
  await writeFile(
    join(FIXTURES, "utf8bom-crlf.txt"),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${bomCrlf}\r\n`, "utf8")]),
  );

  // A NUL byte makes the codec reject it as binary.
  await writeFile(
    join(FIXTURES, "unsupported.bin"),
    Buffer.concat([Buffer.from("binary payload"), Buffer.from([0x00, 0x01, 0x02])]),
  );

  // 20-50 MB text document for the SC-005 benchmark.
  const stream = createWriteStream(join(FIXTURES, "large.txt"), { encoding: "utf8" });
  const chunkLines = Array.from(
    { length: 5000 },
    (_, index) => `large line ${index} — the quick brown fox jumps over the lazy dog`,
  ).join("\n");
  let written = 0;
  let block = 0;
  while (written < LARGE_BYTES) {
    const text = `${chunkLines}\n`;
    if (!stream.write(text)) {
      await once(stream, "drain");
    }
    written += Buffer.byteLength(text, "utf8");
    block += 1;
  }
  stream.end();
  await once(stream, "finish");

  console.log(`fixtures written to ${FIXTURES}`);
  console.log(`  small-a.txt       ${(await import("node:fs/promises")).stat}`);
  console.log(`  large.txt         ${(written / (1024 * 1024)).toFixed(1)} MB`);
}

await main();
