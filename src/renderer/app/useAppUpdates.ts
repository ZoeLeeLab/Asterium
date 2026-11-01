import { useEffect, useState } from 'react';
import { APP_VERSION } from '../../shared/appRelease';
import type { UpdateSnapshot } from '../../shared/appUpdates';

export function useAppUpdates() {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot>({ configured: false, currentVersion: APP_VERSION, phase: 'unconfigured' });
  useEffect(() => {
    const api = window.asteriumUpdates;
    if (!api) return;
    let active = true, changes = 0;
    const unsubscribe = api.onChanged(next => { changes++; if (active) setSnapshot(next); });
    void api.get().then(next => { if (active && !changes) setSnapshot(next); }).catch(() => {
      if (active && !changes) setSnapshot(current => ({ ...current, phase: 'error', error: 'UPDATE_STATUS_UNAVAILABLE' }));
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  return snapshot;
}

export function updateStatusText(snapshot: UpdateSnapshot) {
  const errors: Record<string, string> = {
    UPDATE_RATE_LIMIT: '检查过于频繁，请稍后重试。', UPDATE_NETWORK_ERROR: '无法连接更新服务，请检查网络后重试。',
    UPDATE_TIMEOUT: '连接超时，请稍后重试。', UPDATE_CANCELLED: '已取消，可稍后重试。',
    UPDATE_CHECKSUM_UNAVAILABLE: '新版缺少完整校验信息，暂不能下载。', UPDATE_CHECKSUM_MISMATCH: '安装包校验失败，请重新下载。',
    UPDATE_SIZE_MISMATCH: '下载文件大小异常，请重新下载。', UPDATE_WINDOWS_ASSET_MISSING: '新版尚未提供唯一可用的 Windows x64 安装包。',
    UPDATE_ASSET_ORIGIN_REJECTED: '更新下载地址不符合配置的发布源。', UPDATE_INSTALL_UNAVAILABLE: '请在已打包的 Windows 客户端中安装更新。',
    UPDATE_INSTALL_FAILED: '安装向导未能启动，可重试或手动下载新版。',
  };
  if (snapshot.phase === 'error') return errors[snapshot.error ?? ''] ?? '更新操作失败，请稍后重试。';
  return ({ unconfigured: '更新源待配置', idle: '可检查新版本', checking: '正在检查更新…', available: `发现新版本 ${snapshot.release?.version ?? ''}`,
    'up-to-date': '当前已是所选更新通道的最新版本', downloading: `正在下载 ${snapshot.totalBytes ? Math.floor((snapshot.receivedBytes ?? 0) / snapshot.totalBytes * 100) : 0}%`,
    downloaded: '新版已下载并通过 SHA-256 校验', installing: '正在退出并启动安装向导…' } as const)[snapshot.phase];
}
