// Runs the first ```js block of every package README against the built packages (run `npm run build` first).
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Inside node_modules so bare imports (@paperkit-latex/*, pdf-lib, jszip) resolve like a consumer's would.
const out = path.join(root, "node_modules", ".readme-examples");
mkdirSync(out, { recursive: true });
let failed = 0;
for (const name of readdirSync(path.join(root, "packages"))) {
  const md = readFileSync(path.join(root, "packages", name, "README.md"), "utf8");
  const code = md.match(/```js\n([\s\S]*?)```/)?.[1];
  if (!code) continue;
  const file = path.join(out, `${name}.mjs`);
  writeFileSync(file, code);
  try {
    const stdout = execFileSync(process.execPath, [file], { encoding: "utf8" });
    console.log(`--- ${name}: OK\n${stdout}`);
  } catch (err) {
    failed++;
    console.error(`--- ${name}: FAILED\n${err.stdout ?? ""}${err.stderr ?? err}`);
  }
}
process.exit(failed ? 1 : 0);
