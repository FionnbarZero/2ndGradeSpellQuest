import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const requiredFiles = ["index.html", "styles.css", "app.js", "engine.js", "curriculum.js", "favicon.svg"];

await Promise.all(requiredFiles.map((file) => access(join("dist", file), constants.R_OK)));

const index = await readFile(join("dist", "index.html"), "utf8");
for (const asset of ["./styles.css", "./app.js", "./favicon.svg"]) {
  if (!index.includes(asset)) {
    throw new Error(`dist/index.html does not reference ${asset}`);
  }
}

console.log(`2nd Grade SpellQuest static build is ready (${requiredFiles.length} required files verified).`);
