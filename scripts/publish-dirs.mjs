/**
 * Print the directory of each publishable package, one per line.
 *
 * A separate entry point so the release workflow's shell loop never has to embed JavaScript in
 * a YAML block scalar — an arrangement where a quoting mistake is invisible until the one run
 * that matters.
 */

import { assertNothingForbidden, publishSet } from "./publish-set.mjs";

const packages = publishSet();
assertNothingForbidden(packages);
for (const pkg of packages) console.log(pkg.dir);
