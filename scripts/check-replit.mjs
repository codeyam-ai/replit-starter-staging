// `npm run check:replit` — assert the committed workspace configuration can
// actually reach the Preview panel: `.replit` wires Run to the editor, and
// `package.json` still has the launcher Run calls. Fast, offline, and safe to
// run anywhere; `npm run smoke` runs the same checks against a fresh clone
// before it starts the editor.
//
// `package.json` is checked here because it is the one file shared with the
// application built on top of this starter. A scaffolder that writes its own
// over ours takes `npm run codeyam` with it, and the only symptom is a Run
// button that appears to do nothing.

import { readFileSync } from "node:fs";
import { checkReplitConfig, checkStarterPackage } from "./replit-config.mjs";

const dir = process.argv[2];
const sections = [
  { path: dir ? `${dir}/.replit` : ".replit", run: checkReplitConfig },
  {
    path: dir ? `${dir}/package.json` : "package.json",
    run: checkStarterPackage,
  },
];

let failures = 0;
for (const { path, run } of sections) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`Cannot read ${path}: ${error.message}`);
    process.exit(1);
  }

  console.log(`\nWorkspace configuration (${path})`);
  for (const { name, ok, detail } of run(text)) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
    if (!ok) {
      failures += 1;
      if (detail) console.log(`        ${detail}`);
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed.\n` : "\nAll checks passed.\n");
process.exit(failures ? 1 : 0);
