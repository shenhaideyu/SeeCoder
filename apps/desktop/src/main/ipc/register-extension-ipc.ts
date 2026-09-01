import { ipcMain } from 'electron';
import type { ExtensionService } from '../services/extension-service';

export function registerExtensionIpc(service: ExtensionService): void {
  ipcMain.handle('extension:list', async () =>
    (await service.list()).map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      relativePath: item.relativePath,
      path: item.path,
      kind: item.kind,
      scope: item.scope,
      sourcePath: item.sourcePath,
      hookStatus: item.hookStatus,
      hookError: item.hookError,
    })),
  );
  ipcMain.handle('extension:import', async () => service.importLocal());
  ipcMain.handle('extension:refresh', async (_event, skillId: string) => service.refresh(skillId));
  ipcMain.handle('extension:rename', async (_event, skillId: string, name: string) => service.rename(skillId, name));
  ipcMain.handle('extension:delete', async (_event, skillId: string) => service.delete(skillId));
  ipcMain.handle('extension:openSource', async (_event, skillId: string) => service.openSource(skillId));
  ipcMain.handle('extension:trustHooks', async (_event, enabled: boolean) => service.trustHooks(enabled));
}
