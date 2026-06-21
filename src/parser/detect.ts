import * as fs from 'fs';
import * as path from 'path';

// ─── Auto-detect source globs for any project structure ───────────────────────
//
// Priority:
//   1. tsconfig.json "include" array  -- most reliable, project already defines it
//   2. tsconfig.json "rootDir"        -- common fallback
//   3. Known source directories that exist on disk (src, app, pages, lib, etc.)
//   4. Root-level scan                -- last resort, catches anything

export function detectSourceGlobs(workspaceRoot: string): string[] {
  const exts = '{ts,tsx,js,jsx}';

  // ── 1. tsconfig.json ────────────────────────────────────────────────────────
  const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    try {
      // Strip comments so JSON.parse doesn't choke on tsconfig comments
      const raw = fs.readFileSync(tsconfigPath, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(raw);

      // "include" array is the most explicit signal
        if (Array.isArray(tsconfig.include) && tsconfig.include.length > 0) {
          const globs = tsconfig.include
            .map((p: string) => {
              const base = p
                .replace(/\/\*\*\/\*(\.\w+)?$/, '')
                .replace(/\/\*(\.\w+)?$/, '')
                .replace(/\.$/, '')
                .replace(/\*$/, '')
                .replace(/\/$/, '');
              return base;
            })
            .filter((base: string) =>
              base.length > 0 &&
              !base.includes('*') &&          // skip glob patterns like **/*.tsx
              !path.extname(base)             // skip file entries like nativewind-env.d.ts
            )
            .map((base: string) => `${base}/**/*.${exts}`)
            .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);

          if (globs.length > 0) {
            console.log(`[GraphMem] Detected source globs from tsconfig.include:`, globs);
            return globs;
          }
          // All include entries were globs/files, not directories — fall through
        }

      // "rootDir" is less explicit but still useful
      const rootDir = tsconfig.compilerOptions?.rootDir;
      if (rootDir && rootDir !== '.') {
        const glob = `${rootDir.replace(/^\.\//, '')}/**/*.${exts}`;
        console.log(`[GraphMem] Detected source glob from tsconfig.rootDir:`, glob);
        return [glob];
      }
    } catch (e) {
      console.warn('[GraphMem] Could not parse tsconfig.json, falling back to directory detection');
    }
  }

  // ── 2. Known source directories ──────────────────────────────────────────────
  // Ordered by likelihood of containing application code
  const candidates = ['src', 'app', 'pages', 'lib', 'components', 'utils', 'hooks', 'server', 'client'];
  const found = candidates.filter(dir =>
    fs.existsSync(path.join(workspaceRoot, dir)) &&
    fs.statSync(path.join(workspaceRoot, dir)).isDirectory()
  );

  if (found.length > 0) {
    const globs = found.map(dir => `${dir}/**/*.${exts}`);
    console.log(`[GraphMem] Detected source globs from directories:`, globs);
    return globs;
  }

  // ── 3. Root-level fallback ───────────────────────────────────────────────────
  console.log('[GraphMem] No source structure detected, scanning root');
  return [`**/*.${exts}`];
}
