import type { ApiProviderAdapter } from './ApiProviderAdapter';
import { abortable } from './abortable';
import type { SessionBootstrapDocument } from '../../shared/agentProtocol';
import { profileReloadPrompt } from '../runtime/SessionProfileReloadService';
import type { ProfileKind } from '../runtime/AppliedSessionProfiles';

export async function confirmProfileReload(provider: ApiProviderAdapter, kind: ProfileKind, bootstrap: SessionBootstrapDocument, signal: AbortSignal) {
  const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]);
  const stream = provider.stream({ signal: combined, tools: [], messages: [{ role: 'system', content: bootstrap.content }, { role: 'user', content: profileReloadPrompt(kind, bootstrap) }] })[Symbol.asyncIterator]();
  let message = '', completed = false;
  try {
    for (;;) {
      const next = await abortable(stream.next(), combined); if (next.done) break;
      if (next.value.type === 'tool.delta') throw new Error('PROFILE_RELOAD_UNEXPECTED_TOOL');
      if (next.value.type === 'text.delta') { message += next.value.text; if (message.length > 4000) throw new Error('PROFILE_RELOAD_RESPONSE_TOO_LARGE'); }
      if (next.value.type === 'finish') { if (!['stop', 'end_turn'].includes(next.value.reason)) throw new Error('PROFILE_RELOAD_INCOMPLETE'); completed = true; }
    }
    signal.throwIfAborted();
    if (!completed || !message.trim()) throw new Error('PROFILE_RELOAD_INCOMPLETE');
    return message.trim();
  } finally { controller.abort(); void Promise.resolve(stream.return?.()).catch(() => undefined); }
}
