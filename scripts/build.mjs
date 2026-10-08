import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CURRENT_WEEK } from "../dist/curriculum.js";
import { WORD_DETAILS } from "../dist/engine.js";

const requiredFiles = ["index.html", "styles.css", "app.js", "engine.js", "curriculum.js", "favicon.svg"];

await Promise.all(requiredFiles.map((file) => access(join("dist", file), constants.R_OK)));
for (const file of ["app.js", "engine.js", "curriculum.js"]) {
  execFileSync(process.execPath, ["--check", join("dist", file)], { stdio: "inherit" });
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(CURRENT_WEEK.id) || CURRENT_WEEK.spellingTargets.length !== 4 ||
  new Set(CURRENT_WEEK.spellingTargets).size !== 4 || CURRENT_WEEK.spellingTargets.some(word => !/^[a-z]+$/.test(word) || !WORD_DETAILS[word]?.sentence)) {
  throw new Error("Each curriculum release needs a dated week ID and four unique red words with spoken example sentences.");
}

const index = await readFile(join("dist", "index.html"), "utf8");
for (const asset of ["./styles.css", "./app.js", "./favicon.svg"]) {
  if (!index.includes(asset)) {
    throw new Error(`dist/index.html does not reference ${asset}`);
  }
}

console.log(`2nd Grade SpellQuest static build is ready (syntax, curriculum, and ${requiredFiles.length} required files verified).`);
