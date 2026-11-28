/* eslint-disable @typescript-eslint/no-require-imports -- Worker eval executes CommonJS, independently of the Main bundle. */
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

// Only this fixed projection runs here. Main validates/rebuilds the index under
// its history queue before starting this read-only worker. No renderer SQL or
// credentials cross this boundary. Embed the source in Main so dev, tests and
// packaged ASAR all run the same worker without a second deployment path.
let database;
let reply;
try {
  database = new DatabaseSync(workerData.file, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 2000');
  const current = database.prepare('SELECT generation FROM index_generation LIMIT 1').get();
  if (current?.generation !== workerData.generation) throw Error('SINGLE_CHAT_HISTORY_STALE_GENERATION');
  const projection = database.prepare("SELECT json_remove(payload, '$.timeline', '$.toolEvents', '$.attachments', '$.quote') AS data FROM messages WHERE chat_id = ? ORDER BY position");
  const messages = workerData.conversationIds.map(id => projection.all(id).map(row => {
    try { return JSON.parse(String(row.data)); }
    catch { throw Error('SINGLE_CHAT_INDEX_INVALID_ROW'); }
  }));
  reply = { messages };
} catch (error) {
  reply = { error: error instanceof Error ? error.message : 'SINGLE_CHAT_PROJECTION_WORKER_FAILED' };
} finally {
  database?.close();
}
parentPort.postMessage(reply);
parentPort.close();
