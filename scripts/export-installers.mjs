import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(
  await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
);
const source = path.join(root, "src-tauri/target/release/bundle/nsis");
const destination = path.join(root, "release");
const prefix = `${config.productName}_${config.version}_`;
const installers = (await readdir(source, { withFileTypes: true }))
  .filter(
    (entry) =>
      entry.isFile() &&
      entry.name.startsWith(prefix) &&
      entry.name.endsWith("-setup.exe"),
  )
  .map((entry) => entry.name);

if (installers.length === 0) {
  throw new Error(`No installer for ${config.version} found in ${source}`);
}

await mkdir(destination, { recursive: true });
for (const name of installers) {
  const output = path.join(destination, name);
  await copyFile(path.join(source, name), output);
  console.log(`Installer: ${output}`);
}
