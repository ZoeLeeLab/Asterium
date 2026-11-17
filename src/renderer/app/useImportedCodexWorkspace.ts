import { useCallback, useEffect, useRef, useState } from 'react';
import type { CodexImportedWorkspaceStatus } from '../../shared/codexThreadImport';
import type { Conversation } from '../types/domain';

export function useImportedCodexWorkspace(conversation: Conversation | undefined) {
  const id = conversation?.importedCodexThread ? conversation.id : undefined;
  const partnerId = conversation?.partnerId;
  const busyRun = Boolean(conversation?.activeRun || conversation?.awaitingFirstResponse);
  const [status, setStatus] = useState<{ id: string; workspace: CodexImportedWorkspaceStatus }>();
  const [choosingId, setChoosingId] = useState<string>();
  const [error, setError] = useState<{ id: string; message: string }>();
  const revision = useRef(0);
  const check = useCallback(async () => {
    if (!id || !partnerId) return true;
    const requested = ++revision.current;
    try {
      const read = window.asteriumAgents?.codexImportedWorkspaceStatus;
      if (!read) return false;
      const workspace = await read(partnerId, id);
      if (requested === revision.current) setStatus({ id, workspace });
      return workspace.available;
    } catch {
      return false;
    }
  }, [id, partnerId]);

  useEffect(() => {
    if (!id || busyRun) return;
    const refresh = () => { void check(); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [busyRun, check, id]);

  const choose = async () => {
    if (!id || !partnerId || choosingId || busyRun) return;
    setChoosingId(id);
    setError(undefined);
    try {
      const workspace = await window.asteriumAgents?.chooseCodexImportedDirectory?.(partnerId, id);
      if (workspace) {
        revision.current++;
        setStatus({ id, workspace });
      }
    } catch {
      setError({ id, message: '无法使用这个目录，请选择可访问的项目目录。' });
    } finally {
      setChoosingId(undefined);
    }
  };

  return {
    workspace: status?.id === id ? status?.workspace : undefined,
    error: error?.id === id ? error?.message : undefined,
    choosing: choosingId === id && Boolean(id),
    check,
    choose,
  };
}
