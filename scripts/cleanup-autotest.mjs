import fs from 'node:fs';
import path from 'node:path';
import { cleanupAutoTestRun } from '../tests/helpers/autoTest.mjs';

const index = process.argv.indexOf('--run'), root = index < 0 ? undefined : process.argv[index + 1];
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('run-') || fs.lstatSync(root).isSymbolicLink()) throw Error('Use --run <exact owned run directory> [--remove]. No directory scan is performed.');
const run = JSON.parse(fs.readFileSync(path.join(root, '.asterium-autotest-run.v1.json'), 'utf8'));
if (process.argv.includes('--remove')) {
  cleanupAutoTestRun({ ...run, root }, { allowFailed: true }); console.log(`Removed owned test run: ${root}`);
} else console.log(JSON.stringify({ root, pid: run.pid, createdAt: run.createdAt, action: 'inspect-only; use --remove after processes have exited' }));
