import { spawn } from 'node:child_process';
import readline from 'node:readline';

/** Prepare only a synthetic thread, with a catalog model override scoped to that thread. */
export async function prepareCodexPlanThread(executable, cwd) {
  const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let nextId = 0, settleTurn;
  const lines = readline.createInterface({ input: child.stdout });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  lines.on('line', (line) => {
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`CODEX_FIXTURE_RPC: ${message.error.message}`)); else waiter.resolve(message.result);
    } else if (message.method === 'error' && message.params?.willRetry !== true) settleTurn?.reject(new Error(`CODEX_FIXTURE_MODEL: ${message.params?.error?.message}`));
    else if (message.method === 'turn/completed') settleTurn?.resolve();
  });
  child.once('error', (error) => { for (const waiter of pending.values()) waiter.reject(error); settleTurn?.reject(error); });
  const timer = setTimeout(() => { for (const waiter of pending.values()) waiter.reject(new Error('CODEX_FIXTURE_TIMEOUT')); settleTurn?.reject(new Error('CODEX_FIXTURE_TIMEOUT')); }, 60_000);
  try {
    await request('initialize', { clientInfo: { name: 'asterium_plan_fixture', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const catalog = await request('model/list');
    const model = (catalog.data?.find((item) => item.isDefault) ?? catalog.data?.[0])?.model;
    if (!model) throw new Error('CODEX_FIXTURE_MODEL_MISSING');
    const started = await request('thread/start', { cwd, model });
    const threadId = started.thread?.id; if (!threadId) throw new Error('CODEX_FIXTURE_THREAD_MISSING');
    const completed = new Promise((resolve, reject) => { settleTurn = { resolve, reject }; });
    void completed.catch(() => undefined);
    await request('turn/start', { threadId, model, input: [{ type: 'text', text: '这是一条隔离测试的准备消息。只回复 S2_READY，不使用工具，不创建文件。' }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } });
    await completed;
    return { threadId, model };
  } finally { clearTimeout(timer); lines.close(); child.kill(); }
}
