/**
 * Loads the 3D Workshop's Babylon.js engine (renderer/v2/workshop3d.js) the first time a 3D workshop opens.
 * A same-folder script, so the window's CSP (script-src 'self') is unchanged and nothing comes from the network.
 */
import type { createWorkshop3D } from './engine3d';

export interface Engine3DModule { createWorkshop3D: typeof createWorkshop3D; ENGINE_LABEL: string }

let loading: Promise<Engine3DModule> | null = null;

export function loadEngine3d(): Promise<Engine3DModule> {
  const ready = (window as unknown as { PandeshWorkshop3D?: Engine3DModule }).PandeshWorkshop3D;
  if (ready) return Promise.resolve(ready);
  if (loading) return loading;
  loading = new Promise<Engine3DModule>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'workshop3d.js';
    script.async = true;
    script.onload = () => {
      const mod = (window as unknown as { PandeshWorkshop3D?: Engine3DModule }).PandeshWorkshop3D;
      if (mod) resolve(mod); else reject(new Error('the 3D engine script loaded but did not start'));
    };
    script.onerror = () => { loading = null; reject(new Error('the 3D engine (workshop3d.js) could not be loaded')); };
    document.head.appendChild(script);
  });
  return loading;
}
