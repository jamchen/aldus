#!/usr/bin/env node
/**
 * The `aldus` executable.
 *
 * The only file in this package that touches process globals. Everything else takes an injected
 * {@link CliEnvironment}, which is what lets the whole command surface be tested in-process —
 * a CLI tested only by spawning subprocesses ends up with its interesting branches untested
 * because they are awkward to reach.
 */

import { run } from "./cli.js";

const code = await run({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
});

process.exitCode = code;
