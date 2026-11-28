import { contextBridge, ipcRenderer } from 'electron';
import { STARTUP_IPC, type AsteriumSplashApi, type StartupWindowSnapshot } from '../shared/startupWindow';

// A splash never receives the full chat/workspace/credential bridge.
contextBridge.exposeInMainWorld('asteriumSplash', {
  get: () => ipcRenderer.invoke(STARTUP_IPC.control, 'get'),
  retry: () => ipcRenderer.invoke(STARTUP_IPC.control, 'retry'),
  quit: () => ipcRenderer.invoke(STARTUP_IPC.control, 'quit'),
  onState(listener) {
    const handler = (_event: Electron.IpcRendererEvent, state: StartupWindowSnapshot) => listener(state);
    ipcRenderer.on(STARTUP_IPC.state, handler);
    return () => ipcRenderer.removeListener(STARTUP_IPC.state, handler);
  },
} satisfies AsteriumSplashApi);
