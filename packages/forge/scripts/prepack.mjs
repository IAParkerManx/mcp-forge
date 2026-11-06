// Copy the repository's README, LICENSE and DISCLAIMER into the package so the
// published tarball is self-contained (run after the build by `prepack`).
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));
for (const file of ["README.md", "LICENSE", "DISCLAIMER.md"]) copyFileSync(`${root}${file}`, `${pkg}${file}`);
