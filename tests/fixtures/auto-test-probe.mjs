import { runAutoTest, autoTestEvidence, spawnTestProcess, createTestHttpServer } from '../helpers/autoTest.mjs';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

await runAutoTest(async () => {
  const mode = process.argv[2];
  const report = { root: process.env.ASTERIUM_AUTOTEST_RUN_ROOT, worker: os.tmpdir(), evidence: autoTestEvidence('probe') };
  writeFileSync(path.join(report.evidence, 'synthetic.txt'), 'isolated fixture');
  if (mode === 'both') {
    const server = createTestHttpServer();
    Object.defineProperty(server, 'listening', { value: true });
    server.close = callback => { callback(new Error('EXPECTED_CLEANUP_FAILURE')); return server; };
  }
  if (mode === 'child') {
    const child = spawnTestProcess(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    report.childPid = child.pid;
  }
  console.log(JSON.stringify(report));
  if (mode === 'fail' || mode === 'both') throw new Error('EXPECTED_PROBE_FAILURE');
});
