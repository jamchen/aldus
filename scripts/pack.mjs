/**
 * Pack the publish set into real tarballs.
 *
 * `npm pack --dry-run` reports what *would* be included; this produces the actual archives the
 * clean-consumer gate installs. The difference matters: a dry run cannot prove that a tarball
 * extracts, that its `exports` map resolves, or that its declarations are reachable.
 *
 * Usage: node scripts/pack.mjs [--out <dir>] [--json]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNothingForbidden, publishSet, repoRoot } from "./publish-set.mjs";

/**
 * Pack every publishable workspace into `outDir`.
 *
 * @returns one entry per package: its name, version, and the absolute tarball path.
 */
export function packAll(outDir) {
  const packages = publishSet();
  assertNothingForbidden(packages);
  mkdirSync(outDir, { recursive: true });

  return packages.map(({ name, dir, manifest }) => {
    // --json rather than parsing stdout: the filename npm chooses for a scoped package is its
    // own business, and guessing at it is how a gate silently packs nothing.
    const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", outDir], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [info] = JSON.parse(raw);
    return {
      name,
      version: manifest.version,
      tarball: resolve(outDir, info.filename),
      entryCount: info.entryCount,
      unpackedSize: info.unpackedSize,
      files: info.files.map((file) => file.path),
    };
  });
}

/** A fresh temporary directory for tarballs. */
export function makeTarballDir() {
  return mkdtempSync(join(tmpdir(), "aldus-tarballs-"));
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const outIndex = process.argv.indexOf("--out");
  const outDir = outIndex === -1 ? makeTarballDir() : resolve(process.argv[outIndex + 1]);
  const packed = packAll(outDir);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ outDir, packed }, null, 2));
  } else {
    console.log(`Packed ${packed.length} tarballs into ${outDir}\n`);
    for (const pkg of packed) {
      const size = `${Math.round(pkg.unpackedSize / 1024)} KB`;
      console.log(
        `  ${pkg.name}@${pkg.version}  ${String(pkg.entryCount).padStart(4)} files  ${size}`,
      );
    }
    console.log(`\nRepository root: ${repoRoot}`);
  }
}
