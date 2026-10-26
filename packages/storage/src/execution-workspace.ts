import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface DirectoryIdentity { path: string; device: number; inode: number }
export interface ExecutionWorkspaceIdentity {
  version: 1; key: string; cwd: DirectoryIdentity; resource: DirectoryIdentity;
}
function directory(path: string): DirectoryIdentity {
  const canonical = realpathSync(path), info = statSync(canonical);
  if (!info.isDirectory()) throw new Error('Workspace is not a directory');
  return { path: canonical, device: info.dev, inode: info.ino };
}
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Read Git's local layout inside the admission transaction; never spawn a command or trust a request key. */
export function resolveExecutionWorkspace(cwd: string): ExecutionWorkspaceIdentity {
  const current = directory(cwd);
  let ancestor = current.path;
  for (;;) {
    const marker = join(ancestor, '.git');
    let gitDir: string | undefined;
    if (present(marker)) {
      if (statSync(marker).isDirectory()) {
        // Git ignores an empty .git shell (for example a lone config.worktree file).
        if (present(join(marker, 'HEAD'))) gitDir = marker;
        else if (present(join(marker, 'objects')) || present(join(marker, 'refs'))) throw new Error('Incomplete Git directory');
      }
      else {
        const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readFileSync(marker, 'utf8'));
        if (!match) throw new Error('Invalid Git directory marker');
        gitDir = resolve(ancestor, match[1]!);
      }
    } else if (present(join(ancestor, 'HEAD')) && present(join(ancestor, 'objects')) && present(join(ancestor, 'refs'))) gitDir = ancestor;
    if (gitDir) {
      gitDir = realpathSync(gitDir);
      const commonFile = join(gitDir, 'commondir');
      const common = present(commonFile) ? readFileSync(commonFile, 'utf8').trim() : undefined;
      if (common === '') throw new Error('Invalid Git common directory');
      const resource = directory(common ? resolve(gitDir, common) : gitDir);
      if (!present(join(gitDir, 'HEAD')) || !statSync(join(resource.path, 'objects')).isDirectory() || !statSync(join(resource.path, 'refs')).isDirectory()) throw new Error('Incomplete Git repository');
      return { version: 1, key: `git:${resource.path}`, cwd: current, resource };
    }
    const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  return { version: 1, key: `directory:${current.path}`, cwd: current, resource: current };
}
