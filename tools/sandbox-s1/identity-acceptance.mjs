// Checks the current AppContainer token and a rejecting LPAC expectation. Never resumes.
import assert from 'node:assert/strict';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFixture, evidenceDirectory, inspectHost, parseOptions, runPoc, selectPocPolicy } from './runner.mjs';

let report;
const reportPath = path.join(evidenceDirectory, 'identity-acceptance.json');
try {
  const options = parseOptions(process.argv.slice(2));
  const policy = selectPocPolicy(options);
  if (!policy.launchPoc) console.log(JSON.stringify({ status: 'not_started', policy }));
  else {
    const host = await inspectHost(options);
    assert.equal(host.elevated, false, 'S1_ELEVATED_HELPER_REFUSED');
    report = { status: 'running', at: new Date().toISOString(), helperIdentity: host, cases: [], production: 'unchanged', build: JSON.parse(await readFile(path.join(evidenceDirectory, 'build.json'), 'utf8')) };
    const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
    const profile = 'appcontainer';
    for (const mismatch of [false, true]) {
      const fixture = await createFixture();
      const record = { profile, mismatch, runDirectory: fixture.runDirectory, status: 'running' }; report.cases.push(record); await save();
      let cleanupConfirmed = false;
      try {
        const expectedIdentityProfile = mismatch ? 'lpac' : profile;
        let result, failure;
        try {
          result = await runPoc({ ...options, fixture, profile, expectedIdentityProfile, identityOnly: true,
            executable: fixture.node, args: ['-e', "require('node:fs').writeFileSync('must-not-run.txt','unexpected')"] });
        } catch (error) { failure = error; }
        if (mismatch) {
          assert.ok(failure, 'Mismatched identity must be rejected');
          record.rejection = { code: failure.message, started: failure.started, cleanup: failure.cleanup };
          cleanupConfirmed = failure.cleanup?.type === 'cleaned';
          assert.equal(failure.message, 'S1_IDENTITY_PROFILE_MISMATCH'); assert.equal(failure.started, false); assert.ok(cleanupConfirmed);
        } else {
          if (failure) throw failure;
          record.result = result; cleanupConfirmed = result.cleanup === 'confirmed';
          assert.equal(result.type, 'identity_result'); assert.equal(result.started, false); assert.ok(cleanupConfirmed);
          assert.equal(result.identity.observedProfile, profile);
          assert.equal(result.identity.allApplicationPackagesAllowed, profile === 'appcontainer');
        }
        await assert.rejects(access(path.join(fixture.workspace, 'must-not-run.txt')), error => error.code === 'ENOENT');
        record.status = 'passed'; console.log(`S1_IDENTITY_PASS ${profile} ${mismatch ? 'mismatch-rejected' : 'verified-without-resume'}`);
      } catch (error) { record.status = 'failed'; record.error = error.message; throw error; }
      finally { if (cleanupConfirmed) await unlink(fixture.node); await save(); }
    }
    report.status = 'passed_identity_only'; await save(); console.log(JSON.stringify({ status: report.status, reportPath }, null, 2));
  }
} catch (error) {
  if (report) { report.status = 'failed'; report.error = error.message; await writeFile(reportPath, JSON.stringify(report, null, 2)); }
  console.error(error.message); process.exitCode = 1;
}
