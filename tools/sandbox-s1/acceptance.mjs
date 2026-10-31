// Explicit, developer-only real Windows acceptance. No models or private credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupFixture, createFixture, evidenceDirectory, inspectHost, parseOptions, repository, runPoc, selectPocPolicy } from './runner.mjs';
import { stageRuntime } from './runtime-fixtures.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function waitGone(pid) {
  const until = Date.now() + 5000;
  while (alive(pid) && Date.now() < until) await delay(25);
  assert.equal(alive(pid), false, `Process ${pid} survived cleanup`);
}

// A separate owner lets acceptance test a real owner crash without killing itself.
if (process.argv[2] === '--owner-worker') {
  const { fixture, profile, testLauncher } = JSON.parse(Buffer.from(process.argv[3], 'base64').toString());
  await runPoc({ enabled: true, fixture, profile, testLauncher, executable: fixture.node, args: ['--preserve-symlinks-main', 'tree.cjs'], timeoutMs: 20_000,
    onReady: event => console.log(JSON.stringify({ type: 'helper', pid: event.helperPid })),
    onOutput: (type, bytes) => { if (type === 'stdout') process.stdout.write(bytes); } });
} else {
  let report;
  let reportPath;
  try {
    const options = parseOptions(process.argv.slice(2));
    const policy = selectPocPolicy(options);
    if (!policy.launchPoc) {
      console.log(JSON.stringify({ status: 'not_started', policy, production: 'unchanged' }, null, 2));
    } else {
      const host = await inspectHost();
      const helperIdentity = options.testLauncher ? await inspectHost(options) : host;
      reportPath = path.join(evidenceDirectory, `acceptance-${options.profile}${options.testLauncher ? '-test-launcher' : ''}.json`);
      report = { profile: options.profile, host, helperIdentity, testLauncher: options.testLauncher, at: new Date().toISOString(), status: 'running', cases: [], compatibility: [], production: 'unchanged', build: JSON.parse(await readFile(path.join(evidenceDirectory, 'build.json'), 'utf8')) };
      if (helperIdentity.elevated) {
        // A BLOCKED report is intentionally not a sandbox pass.
        report.status = 'blocked_non_elevated_required';
        await writeFile(reportPath, JSON.stringify(report, null, 2));
        throw new Error('S1_ELEVATED_HELPER_REFUSED: open a non-administrator PowerShell and run this command again');
      }
      const save = () => writeFile(reportPath, JSON.stringify(report, null, 2));
      const runCase = async (name, body) => {
        const record = { name, status: 'running' }; report.cases.push(record); await save();
        try { await body(record); record.status = 'passed'; }
        catch (error) {
          record.status = 'failed'; record.error = error.message;
          if (typeof error.started === 'boolean') record.started = error.started;
          if (error.helperError) record.helperError = error.helperError;
          if (error.cleanup) record.cleanup = error.cleanup;
          throw error;
        }
        finally { await save(); }
        console.log(`S1_PASS ${name}`);
      };
      const execute = async (source, settings = {}) => {
        const fixture = await createFixture();
        await writeFile(path.join(fixture.workspace, 'probe.cjs'), source);
        let output = '';
        const result = await runPoc({ ...options, ...settings, fixture, executable: fixture.node, args: ['--preserve-symlinks-main', 'probe.cjs', ...(settings.args ?? [])],
          onOutput: (kind, bytes) => { if (kind === 'stdout') output += bytes.toString(); settings.onOutput?.(kind, bytes); },
          onReady: event => settings.onReady?.(event) });
        assert.equal(result.cleanup, 'confirmed');
        await unlink(fixture.node); // Keep small evidence, not a runtime copy per test.
        return { result, fixture, output };
      };

      await runCase('real-workspace-files-environment-and-junction', async record => {
        const fixture = await createFixture(); record.runDirectory = fixture.runDirectory;
        const outside = path.join(fixture.runDirectory, 'outside'); await mkdir(outside);
        await writeFile(path.join(outside, 'sentinel.txt'), 'outside-original');
        const source = `const fs=require('node:fs');
process.stdin.once('data',()=>{
 process.stdin.destroy();
 fs.writeFileSync('created.txt','one'); fs.appendFileSync('created.txt','two');
 const readBack=fs.readFileSync('created.txt','utf8'); fs.writeFileSync('delete-me.txt','x'); fs.unlinkSync('delete-me.txt');
 const failures=[]; const target=process.argv[2];
 for(const [name,fn] of [['read',()=>fs.readFileSync(target)],['write',()=>fs.writeFileSync(target,'escaped')],['junction',()=>fs.readFileSync('link/sentinel.txt')]]){
  try{fn();failures.push(name);}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e;}
 }
 console.log(JSON.stringify({readBack,failures,environmentLeaked:!!process.env.ASTERIUM_S1_FAKE_SECRET}));
});`;
        await writeFile(path.join(fixture.workspace, 'probe.cjs'), source);
        let output = '', errors = '';
        const before = process.env.ASTERIUM_S1_FAKE_SECRET; process.env.ASTERIUM_S1_FAKE_SECRET = 's1-fake-only';
        try {
          const result = await runPoc({ ...options, allowNetwork: false, fixture, executable: fixture.node, args: ['--preserve-symlinks-main', 'probe.cjs', path.join(outside, 'sentinel.txt')],
            onReady: (_event, send) => { symlinkSync(outside, path.join(fixture.workspace, 'link'), 'junction'); send('start'); },
            onOutput: (kind, bytes) => { if (kind === 'stdout') output += bytes.toString(); else errors += bytes.toString(); } });
          record.result = result; record.output = output; record.stderr = errors;
          assert.equal(result.exitCode, 0, `File fixture failed (${result.reason}): ${errors}`); assert.equal(result.cleanup, 'confirmed');
        } finally { if (before === undefined) delete process.env.ASTERIUM_S1_FAKE_SECRET; else process.env.ASTERIUM_S1_FAKE_SECRET = before; }
        assert.deepEqual(JSON.parse(output), { readBack: 'onetwo', failures: [], environmentLeaked: false });
        assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside-original');
        assert.equal(await readFile(path.join(fixture.workspace, 'created.txt'), 'utf8'), 'onetwo');
        report.compatibility.push({ runtime: 'Node', version: process.version, compatible: true, profile: options.profile });
        await unlink(path.join(fixture.workspace, 'link')); await unlink(fixture.node);
      });

      await runCase('literal-argv', async () => {
        const args = ['', 'space value', 'quote"inside', 'trailing\\'];
        const { result, output } = await execute('console.log(JSON.stringify(process.argv.slice(2)))', { args });
        assert.equal(result.exitCode, 0); assert.deepEqual(JSON.parse(output), args);
      });

      await runCase('normal-exit-cleans-detached-descendant', async () => {
        const { result, output } = await execute("const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});p.unref();console.log(p.pid)");
        assert.equal(result.reason, 'exited'); assert.equal(result.exitCode, 0); await waitGone(Number(output.trim()));
      });

      await runCase('cancel-cleans-root-and-descendant', async () => {
        const controller = new AbortController(); let descendant;
        const { result } = await execute("const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(p.pid);setInterval(()=>{},1000)", {
          signal: controller.signal, onOutput: (kind, bytes) => { if (kind === 'stdout') { descendant = Number(bytes.toString().trim()); controller.abort(); } },
        });
        assert.equal(result.reason, 'cancelled'); assert.ok(descendant > 0); await waitGone(descendant);
      });

      await runCase('timeout', async () => {
        const { result } = await execute('setInterval(()=>{},1000)', { timeoutMs: 1000 });
        assert.equal(result.reason, 'timeout');
      });

      await runCase('output-limit', async () => {
        const { result } = await execute("for(;;)process.stdout.write('x'.repeat(8192))");
        assert.equal(result.reason, 'output_limit');
      });

      await runCase('stdio-initialize-list-and-call', async () => {
        const fixture = await createFixture();
        const service = `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const r=JSON.parse(line);let result;
if(r.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'s1-fixture',version:'1'}};
else if(r.method==='tools/list')result={tools:[{name:'echo',description:'S1 only',inputSchema:{type:'object',properties:{value:{type:'string'}}}}]};
else if(r.method==='tools/call')result={content:[{type:'text',text:r.params.arguments.value}]};
else return;console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));});`;
        await writeFile(path.join(fixture.workspace, 'service.cjs'), service);
        let send; let buffered = ''; const replies = []; const controller = new AbortController();
        const result = await runPoc({ ...options, fixture, executable: fixture.node, args: ['--preserve-symlinks-main', 'service.cjs'], signal: controller.signal,
          onReady: (_event, write) => { send = write; send(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 's1', version: '1' } } })}\n`); },
          onOutput: (kind, bytes) => {
            if (kind !== 'stdout') return;
            buffered += bytes.toString();
            while (buffered.includes('\n')) {
              const index = buffered.indexOf('\n'); const response = JSON.parse(buffered.slice(0, index)); buffered = buffered.slice(index + 1); replies.push(response);
              if (response.id === 1) send(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
              else if (response.id === 2) send(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { value: 'S1_STDIO_OK' } } })}\n`);
              else controller.abort();
            }
          } });
        assert.equal(result.reason, 'cancelled'); assert.equal(replies.length, 3); assert.equal(replies[2].result.content[0].text, 'S1_STDIO_OK');
        await unlink(fixture.node);
      });

      const tree = "const p=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({type:'tree',pid:p.pid}));setInterval(()=>{},1000)";
      await runCase('helper-crash-kills-job-and-recovers-only-cleanup', async record => {
        const fixture = await createFixture(); record.runDirectory = fixture.runDirectory;
        await writeFile(path.join(fixture.workspace, 'tree.cjs'), tree);
        let helperPid, descendant, failure; let buffered = '';
        try {
          await runPoc({ ...options, fixture, executable: fixture.node, args: ['--preserve-symlinks-main', 'tree.cjs'],
            onReady: event => { helperPid = event.helperPid; },
            onOutput: (kind, bytes) => {
              if (kind !== 'stdout') return; buffered += bytes.toString();
              if (buffered.includes('\n') && !descendant) { descendant = JSON.parse(buffered.trim()).pid; process.kill(helperPid); }
            } });
        } catch (error) { failure = error; }
        assert.ok(failure, 'A helper crash must not become success'); assert.equal(failure.started, true); assert.equal(failure.cleanup?.type, 'cleaned');
        assert.ok(descendant > 0); await waitGone(descendant); await unlink(fixture.node);
      });

      await runCase('owner-crash-kills-job-and-allows-explicit-recovery', async record => {
        const fixture = await createFixture(); record.runDirectory = fixture.runDirectory;
        await writeFile(path.join(fixture.workspace, 'tree.cjs'), tree);
        const worker = spawn(process.execPath, [scriptPath, '--owner-worker', Buffer.from(JSON.stringify({ fixture, profile: options.profile, testLauncher: options.testLauncher })).toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let helperPid, descendant, buffered = '';
        try {
          await new Promise((resolve, reject) => {
            const deadline = setTimeout(() => reject(new Error('S1_OWNER_WORKER_TIMEOUT')), 25_000);
            worker.once('error', error => { clearTimeout(deadline); reject(error); });
            worker.once('close', () => { clearTimeout(deadline); if (descendant) resolve(); else reject(new Error('S1_OWNER_WORKER_FAILED')); });
            worker.stdout.on('data', bytes => {
              buffered += bytes.toString();
              while (buffered.includes('\n')) {
                const index = buffered.indexOf('\n'); const event = JSON.parse(buffered.slice(0, index)); buffered = buffered.slice(index + 1);
                if (event.type === 'helper') helperPid = event.pid;
                else if (event.type === 'tree') { descendant = event.pid; worker.kill(); }
              }
            });
          });
          assert.ok(descendant > 0 && helperPid > 0); await waitGone(descendant); await waitGone(helperPid);
          assert.equal((await cleanupFixture(fixture, options)).type, 'cleaned'); await unlink(fixture.node);
        } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); }
      });

      await runCase('powershell-compatibility-is-reported-without-fallback', async () => {
        const fixture = await createFixture();
        await writeFile(path.join(fixture.workspace, 'probe.ps1'), "[IO.File]::WriteAllText((Join-Path (Get-Location) 'powershell-result.txt'),'S1_PS_OK'); Write-Output 'S1_PS_OK'");
        let output = '';
        const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        try {
          const result = await runPoc({ ...options, fixture, executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.join(fixture.workspace, 'probe.ps1')],
            onOutput: (_kind, bytes) => { output += bytes.toString(); } });
          report.compatibility.push({ runtime: 'Windows PowerShell', compatible: result.exitCode === 0 && output.includes('S1_PS_OK'), exitCode: result.exitCode, reason: result.reason });
        } catch (error) {
          if (!['cleaned', 'not_needed'].includes(error.cleanup?.type)) throw error;
          report.compatibility.push({ runtime: 'Windows PowerShell', compatible: false, error: error.message });
        }
        await unlink(fixture.node);
      });
      const verifyRuntime = async (kind, sourceDirectory) => {
        await runCase(`${kind}-files-stdio-environment-boundary-and-cancel`, async record => {
          const fixture = await createFixture(); record.runDirectory = fixture.runDirectory;
          const runtime = await stageRuntime(fixture, kind, sourceDirectory);
          const outside = path.join(fixture.runDirectory, 'outside'); await mkdir(outside);
          const sentinel = path.join(outside, 'sentinel.txt'); await writeFile(sentinel, 'outside-original');
          const python = `import os, sys, json, pathlib, subprocess, socket, ssl
sys.stdin.readline()
p=pathlib.Path('runtime-result.txt');p.write_text('one');p.write_text(p.read_text()+'two')
d=pathlib.Path('delete-me.txt');d.write_text('x');d.unlink()
failures=[]
for name,target,mode in [('read',sys.argv[1],'r'),('write',sys.argv[1],'w'),('junction','link/sentinel.txt','r')]:
 try:
  with open(target,mode) as f:
   f.read() if mode=='r' else f.write('escaped')
  failures.append(name)
 except PermissionError: pass
child=subprocess.Popen([sys.executable,'-I','-S','-B','-c',"import time;print('S1_CHILD_READY',flush=True);time.sleep(60)"],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
assert child.stdout.readline().strip()=='S1_CHILD_READY'
print(json.dumps(dict(marker='S1_RUNTIME_OK',version=sys.version.split()[0],failures=failures,readBack=p.read_text(),secret=bool(os.environ.get('ASTERIUM_S1_FAKE_SECRET')),pid=os.getpid(),child=child.pid)),flush=True)
sys.stdin.readline()
`;
          const electron = `const fs=require('node:fs');process.stdin.once('data',()=>{
fs.writeFileSync('runtime-result.txt','one');fs.appendFileSync('runtime-result.txt','two');fs.writeFileSync('delete-me.txt','x');fs.unlinkSync('delete-me.txt');
const failures=[];for(const [name,target,mode] of [['read',process.argv[2],'r'],['write',process.argv[2],'w'],['junction','link/sentinel.txt','r']]){
try{mode==='r'?fs.readFileSync(target):fs.writeFileSync(target,'escaped');failures.push(name)}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e}}
const child=require('node:child_process').spawn(process.execPath,['-e',"require('node:fs').writeFileSync('child-ready.txt',String(process.pid));setInterval(()=>{},1000)"],{stdio:'ignore'});
const ready=setInterval(()=>{if(fs.existsSync('child-ready.txt')){clearInterval(ready);if(Number(fs.readFileSync('child-ready.txt','utf8'))!==child.pid)throw Error('wrong child marker');
console.log(JSON.stringify({marker:'S1_RUNTIME_OK',version:process.versions.electron,node:process.version,failures,readBack:fs.readFileSync('runtime-result.txt','utf8'),secret:!!process.env.ASTERIUM_S1_FAKE_SECRET,pid:process.pid,child:child.pid}));}},25);});`;
          const script = path.join(fixture.workspace, kind === 'python' ? 'probe.py' : 'probe.cjs');
          await writeFile(script, kind === 'python' ? python : electron);
          let output = '', stderr = '', observation;
          const controller = new AbortController();
          const previous = process.env.ASTERIUM_S1_FAKE_SECRET; process.env.ASTERIUM_S1_FAKE_SECRET = 'fake-runtime-test-only';
          let result;
          try {
            result = await runPoc({ ...options, fixture, runtimeKind: kind, executable: runtime.executable,
              args: kind === 'python' ? ['-I', '-S', '-B', script, sentinel] : ['--preserve-symlinks-main', script, sentinel],
              signal: controller.signal,
              onReady: (_event, send) => { symlinkSync(outside, path.join(fixture.workspace, 'link'), 'junction'); send('start\n'); },
              onOutput: (type, bytes) => {
                if (type === 'stderr') { stderr += bytes.toString(); return; }
                output += bytes.toString();
                if (output.includes('\n') && !observation) {
                  observation = JSON.parse(output.trim());
                  assert.equal(alive(observation.pid), true); assert.equal(alive(observation.child), true);
                  controller.abort();
                }
              } });
            record.result = result; record.observation = observation; record.stderr = stderr;
            assert.equal(result.cleanup, 'confirmed'); assert.equal(result.reason, 'cancelled', stderr);
            assert.equal(observation.marker, 'S1_RUNTIME_OK'); assert.equal(observation.readBack, 'onetwo');
            assert.deepEqual(observation.failures, []); assert.equal(observation.secret, false);
            await waitGone(observation.pid); await waitGone(observation.child);
            assert.equal(await readFile(sentinel, 'utf8'), 'outside-original');
            report.compatibility.push({ runtime: kind, version: observation.version, node: observation.node, compatible: true, profile: options.profile,
              scope: 'fixture-files-boundaries-environment-root-stdio-and-cancellation',
              descendantStdio: kind === 'electron' ? 'ignore-with-workspace-ready-marker' : 'pipe-ready-handshake',
              ...(kind === 'electron' ? { knownLimitations: ['Nested pipe stdio spawn stalled on this host; timeout cleanup confirmed. This fixture does not claim nested pipe compatibility.'] } : {}) });
          } finally {
            if (previous === undefined) delete process.env.ASTERIUM_S1_FAKE_SECRET; else process.env.ASTERIUM_S1_FAKE_SECRET = previous;
            if (result?.cleanup === 'confirmed') { await unlink(path.join(fixture.workspace, 'link')); await unlink(fixture.node); await runtime.dispose(); }
          }
        });
      };
      if (options.pythonRuntime) await verifyRuntime('python', path.resolve(options.pythonRuntime));
      else report.compatibility.push({ runtime: 'python', status: 'not_tested', reason: 'Supply --python-runtime with the directory of an existing CPython distribution; nothing is installed' });
      await verifyRuntime('electron', path.resolve(options.electronRuntime ?? path.join(repository, 'node_modules', 'electron', 'dist')));

      await runCase('incompatible-executable-fails-closed-without-replay', async record => {
        const fixture = await createFixture(); record.runDirectory = fixture.runDirectory;
        const executable = path.join(fixture.runDirectory, 'runtime', 'incompatible.exe');
        await writeFile(executable, 'S1 deliberately invalid Windows executable');
        let failure;
        try { await runPoc({ ...options, fixture, executable, args: [] }); } catch (error) { failure = error; }
        assert.ok(failure); assert.match(failure.message, /^S1_PROCESS_START_FAILED/);
        assert.equal(failure.started, false); assert.equal(failure.cleanup?.type, 'cleaned'); assert.deepEqual(failure.events, []);
        record.rejection = { code: failure.message, started: failure.started, cleanup: failure.cleanup };
        await assert.rejects(runPoc({ ...options, fixture, executable, args: [] }), error => error.code === 'EEXIST');
        await unlink(fixture.node);
      });

      if (options.networkUrl) {
        const url = new URL(options.networkUrl);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('S1_PUBLIC_HTTPS_TEST_URL_REQUIRED');
        await runCase('sandbox-network-off-and-on', async record => {
          const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
          assert.ok(response.ok, 'Native baseline test endpoint is unavailable'); await response.body?.cancel();
          const source = "const r=require('node:https').get(process.argv[2],{agent:false},res=>{console.log(JSON.stringify({connected:true,status:res.statusCode}));res.resume()});r.setTimeout(5000,()=>r.destroy(new Error('timeout')));r.on('error',()=>console.log(JSON.stringify({connected:false})))";
          const off = await execute(source, { allowNetwork: false, args: [url.href], timeoutMs: 10_000 });
          assert.equal(off.result.exitCode, 0); assert.equal(JSON.parse(off.output).connected, false);
          const on = await execute(source, { allowNetwork: true, args: [url.href], timeoutMs: 10_000 });
          assert.equal(on.result.exitCode, 0); assert.equal(JSON.parse(on.output).connected, true);
          const after = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
          assert.ok(after.ok, 'Native network must remain available'); await after.body?.cancel();
          record.endpoint = url.href;
          record.nativeBefore = response.status; record.nativeAfter = after.status;
          record.off = { observation: JSON.parse(off.output), result: off.result };
          record.on = { observation: JSON.parse(on.output), result: on.result };
        });
      } else report.cases.push({ name: 'sandbox-network-off-and-on', status: 'pending', reason: 'Supply --network-url with a public HTTPS endpoint you permit testing; no external endpoint is contacted by default' });

      report.status = report.cases.some(item => item.status === 'pending') || report.compatibility.some(item => item.compatible === false || item.status === 'not_tested') ? 'passed_core_with_pending_compatibility' : 'passed';
      await save(); console.log(JSON.stringify({ status: report.status, reportPath }, null, 2));
    }
  } catch (error) {
    if (report && report.status !== 'blocked_non_elevated_required') report.status = 'failed';
    if (report) { report.error = error.message; await writeFile(reportPath, JSON.stringify(report, null, 2)); }
    console.error(error.message); process.exitCode = report?.status === 'blocked_non_elevated_required' ? 2 : 1;
  }
}
