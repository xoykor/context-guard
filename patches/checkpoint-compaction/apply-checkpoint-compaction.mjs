#!/usr/bin/env node
import { accessSync, constants, copyFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function findTarget(explicit) {
  if (explicit) {
    const path = resolve(explicit);
    return realpathSync(statSync(path).isDirectory() ? join(path, manifest.relativeTarget) : path);
  }
  const anchors = [join(process.cwd(), '__dsh_resolve__.cjs')];
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    if (!folder) continue;
    const executable = join(folder, 'dsh');
    try {
      accessSync(executable, constants.X_OK);
      anchors.push(realpathSync(executable));
    } catch {}
  }
  for (const anchor of anchors) {
    try { return realpathSync(createRequire(anchor).resolve(manifest.package)); } catch {}
  }
  throw new Error('Could not resolve @deepseek-ai/dsh-compaction-basic; pass --target /path/to/package or /path/to/lib/index.js.');
}

export function applyPatch({ target, check = false } = {}) {
  const destination = findTarget(target);
  const bytes = readFileSync(destination);
  const observed = hash(bytes);
  const patched = readFileSync(join(here, manifest.relativeTarget));
  if (hash(patched) !== manifest.patchedSha256) throw new Error('Patch payload hash differs from manifest; refusing to write.');
  if (observed === manifest.patchedSha256) return { status: 'patched', changed: false, target: destination, sha256: observed };
  if (observed !== manifest.baseSha256) throw new Error(`Unsupported runtime content at ${destination}: SHA-256 ${observed}; expected ${manifest.baseSha256} or ${manifest.patchedSha256}.`);
  if (check) return { status: 'unpatched', changed: false, target: destination, sha256: observed };
  const backup = `${destination}.before-checkpoint-compaction-${manifest.baseSha256.slice(0, 12)}`;
  if (existsSync(backup)) {
    if (hash(readFileSync(backup)) !== manifest.baseSha256) throw new Error(`Backup differs from the approved base: ${backup}`);
  } else {
    copyFileSync(destination, backup, constants.COPYFILE_EXCL);
  }
  const temporary = `${destination}.checkpoint-compaction-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, patched, { flag: 'wx', mode: statSync(destination).mode });
    chmodSync(temporary, statSync(destination).mode);
    // Refuse a concurrent external edit between reading and applying the patch.
    if (hash(readFileSync(destination)) !== manifest.baseSha256) throw new Error('Runtime changed while preparing patch; refusing to replace it.');
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { status: 'patched', changed: true, target: destination, backup, sha256: hash(readFileSync(destination)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let target;
    let check = false;
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--check') check = true;
      else if (args[index] === '--target' && args[index + 1]) target = args[++index];
      else if (args[index] === '--help') {
        process.stdout.write('Usage: node apply-checkpoint-compaction.mjs [--target PACKAGE_DIR_OR_INDEX_JS] [--check]\n--check is read-only: exit 0 patched, exit 2 unpatched, exit 1 unsupported/error.\n');
        process.exit(0);
      } else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
    }
    const result = applyPatch({ target, check });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (check && result.status === 'unpatched') process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'error', error: error.message })}\n`);
    process.exitCode = 1;
  }
}
