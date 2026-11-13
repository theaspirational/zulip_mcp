// Execute the upstream definitions, never head's definitions, to regenerate the
// no-env tools/list fixture. Run: node --import tsx scripts/snapshot-upstream-tools.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = 'a2bfec1219dd6d365439d9f094f13f7b08b659a8';
const scratch = mkdtempSync(resolve('.tmp/upstream-tools-'));
try {
  for (const file of ['tools', 'tool-classes']) {
    writeFileSync(join(scratch, `${file}.ts`), execFileSync('git', ['show', `${base}:src/${file}.ts`]));
  }
  const { toolDefinitions } = await import(pathToFileURL(join(scratch, 'tools.ts')).href);
  const { withToolClasses } = await import(pathToFileURL(join(scratch, 'tool-classes.ts')).href);
  process.stdout.write(JSON.stringify({ tools: withToolClasses(toolDefinitions) }, null, 2) + '\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
