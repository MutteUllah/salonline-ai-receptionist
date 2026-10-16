import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
let failed = false;
for (const dir of ['server', 'public', 'scripts', 'test']) {
  for (const file of readdirSync(dir).filter(f => /\.(mjs|js)$/.test(f))) {
    const result = spawnSync(process.execPath, ['--check', join(dir, file)], {stdio:'inherit'});
    if(result.status !== 0) failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
