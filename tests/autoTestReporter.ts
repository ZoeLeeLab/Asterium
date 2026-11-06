import type { Reporter } from 'vitest/node';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createAutoTestRun, cleanupAutoTestRun, type AutoTestRun } from './helpers/autoTest.mjs';

export function autoTestReporter(run: AutoTestRun, watch: boolean): Reporter {
  return {
    onTestRunEnd(modules, errors, reason) {
      const passed = reason === 'passed' && errors.length === 0 && modules.every(module => module.state() !== 'failed');
      writeFileSync(path.join(run.root, 'vitest-result.json'), JSON.stringify({ passed, reason,
        modules: modules.map(module => ({ name: module.relativeModuleId, state: module.state() })), unhandledErrors: errors.length }, null, 2));
      if (passed && !watch && process.env.ASTERIUM_AUTOTEST_KEEP !== '1') {
        if (!cleanupAutoTestRun(run)) throw new Error(`AUTOTEST_CLEANUP_RETAINED ${run.root}`);
      } else console.error(`AUTOTEST_EVIDENCE_RETAINED ${run.root}`);
    },
  };
}

export function vitestAutoTestRun() {
  const run = createAutoTestRun();
  return { run, env: { ASTERIUM_AUTOTEST_RUN_ROOT: run.root, ASTERIUM_AUTOTEST_RUN_TOKEN: run.token,
    ASTERIUM_AUTOTEST_SYSTEM_TEMP: run.systemTemp } };
}
