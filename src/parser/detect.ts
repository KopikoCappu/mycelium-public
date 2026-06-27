import * as fs from 'fs';
import * as path from 'path';

// ─── Extension sets by language family ────────────────────────────────────────

const TS_JS   = 'ts,tsx,js,jsx,mjs,cjs';
const WEB     = 'html,htm,css,scss,sass,less';
const PYTHON  = 'py,pyi';
const SYSTEMS = 'rs,c,cpp,cc,cxx,h,hpp,hh';
const GO      = 'go';
const JAVA    = 'java,kt,kts,scala';
const RUBY    = 'rb,rake,gemspec';
const PHP     = 'php';
const SWIFT   = 'swift';
const CSHARP  = 'cs';
const SHELL   = 'sh,bash,zsh,fish';
const CONFIG  = 'toml,yaml,yml,json,jsonc,xml,env';

// Full extension set — used when no project structure hints are found
const ALL_EXTS = `{${[TS_JS, WEB, PYTHON, SYSTEMS, GO, JAVA, RUBY, PHP, SWIFT, CSHARP].join(',')}}`;

// Source directories — ordered by likelihood of containing app code
const SOURCE_CANDIDATES = [
  // Web / Node
  'src', 'app', 'pages', 'lib', 'libs',
  'components', 'utils', 'hooks', 'helpers',
  'server', 'client', 'api', 'routes',
  'middleware', 'services', 'controllers',
  'store', 'stores', 'state',
  'models', 'schemas', 'types',
  // Web asset dirs (scanned with web-only extensions)
  'ui', 'public', 'static', 'assets', 'web',
  // Python
  'scripts', 'tests', 'test',
  // Go / Rust / systems
  'cmd', 'pkg', 'internal', 'core',
  // Ruby / PHP / misc
  'bin', 'config',
];

// Directories to always ignore regardless of project type
const ALWAYS_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  '.next', '.nuxt', '.svelte-kit', '.vite',
  '.mycelium', '__pycache__', '.pytest_cache',
  'coverage', '.nyc_output', '.turbo', '.cache',
  'vendor', 'target',           // Rust / Go build artifacts
  '.idea', '.vscode',
  'migrations',                 // DB migration folders — usually not useful
]);

// ─── Project-type detection ───────────────────────────────────────────────────

interface ProjectHints {
  hasTypeScript: boolean;
  hasPython:     boolean;
  hasRust:       boolean;
  hasGo:         boolean;
  hasJava:       boolean;
  hasRuby:       boolean;
  hasPHP:        boolean;
  hasSwift:      boolean;
  hasCSharp:     boolean;
}

function detectProjectTypes(root: string): ProjectHints {
  const exists = (f: string) => fs.existsSync(path.join(root, f));
  return {
    hasTypeScript: exists('tsconfig.json') || exists('tsconfig.base.json'),
    hasPython:     exists('pyproject.toml') || exists('setup.py') || exists('requirements.txt') || exists('Pipfile'),
    hasRust:       exists('Cargo.toml'),
    hasGo:         exists('go.mod'),
    hasJava:       exists('pom.xml') || exists('build.gradle') || exists('build.gradle.kts'),
    hasRuby:       exists('Gemfile'),
    hasPHP:        exists('composer.json'),
    hasSwift:      exists('Package.swift'),
    hasCSharp:     exists('*.csproj') || exists('*.sln'),
  };
}

function buildExtGlob(hints: ProjectHints): string {
  const sets: string[] = [];

  // Always include TS/JS and web — almost every project has some
  sets.push(TS_JS, WEB);

  if (hints.hasPython)  sets.push(PYTHON);
  if (hints.hasRust)    sets.push(SYSTEMS);
  if (hints.hasGo)      sets.push(GO);
  if (hints.hasJava)    sets.push(JAVA);
  if (hints.hasRuby)    sets.push(RUBY);
  if (hints.hasPHP)     sets.push(PHP);
  if (hints.hasSwift)   sets.push(SWIFT);
  if (hints.hasCSharp)  sets.push(CSHARP);

  // If no language-specific marker found, use everything
  const anySpecific = hints.hasPython || hints.hasRust || hints.hasGo ||
                      hints.hasJava   || hints.hasRuby  || hints.hasPHP  ||
                      hints.hasSwift  || hints.hasCSharp;
  if (!anySpecific)    sets.push(PYTHON, SYSTEMS, GO);

  // Deduplicate individual extensions
  const allExts = [...new Set(sets.join(',').split(','))].join(',');
  return `{${allExts}}`;
}

// ─── Asset directory augmentation ─────────────────────────────────────────────
// tsconfig.include only covers TS/JS source — we always need to add asset dirs
// so HTML/CSS files (like ui/index.html) get their import edges extracted too.

const ASSET_DIRS  = ['ui', 'public', 'static', 'assets', 'web', 'frontend'];
const ASSET_EXTS  = '{html,htm,css,scss,sass,less}';

function addAssetDirs(root: string, globs: string[]): string[] {
  for (const dir of ASSET_DIRS) {
    const full = path.join(root, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      const g = `${dir}/**/*.${ASSET_EXTS}`;
      if (!globs.includes(g)) globs.push(g);
    }
  }
  return globs;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function detectSourceGlobs(workspaceRoot: string): string[] {
  const hints = detectProjectTypes(workspaceRoot);
  const exts  = buildExtGlob(hints);

  // ── 1. tsconfig.json "include" array ────────────────────────────────────────
  const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    try {
      const raw = fs.readFileSync(tsconfigPath, 'utf8')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(raw);

      if (Array.isArray(tsconfig.include) && tsconfig.include.length > 0) {
        const globs = tsconfig.include
          .map((p: string) =>
            p.replace(/\/\*\*\/\*(\.\w+)?$/, '')
             .replace(/\/\*(\.\w+)?$/, '')
             .replace(/\.$/, '')
             .replace(/\*$/, '')
             .replace(/\/$/, '')
          )
          .filter((base: string) =>
            base.length > 0 &&
            !base.includes('*') &&       // skip raw glob patterns
            !path.extname(base)          // skip file entries like env.d.ts
          )
          .map((base: string) => `${base}/**/*.${exts}`)
          .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);

        if (globs.length > 0) {
          // Always augment with asset dirs — tsconfig.include never covers them
          const final = addAssetDirs(workspaceRoot, globs);
          console.log(`[GraphMem] Detected source globs from tsconfig.include:`, final);
          return final;
        }
      }

      // "rootDir" fallback
      const rootDir = tsconfig.compilerOptions?.rootDir;
      if (rootDir && rootDir !== '.') {
        const globs = [`${rootDir.replace(/^\.\//, '')}/**/*.${exts}`];
        const final = addAssetDirs(workspaceRoot, globs);
        console.log(`[GraphMem] Detected source glob from tsconfig.rootDir:`, final);
        return final;
      }
    } catch {
      console.warn('[GraphMem] Could not parse tsconfig.json, falling back to directory detection');
    }
  }

  // ── 2. Other project root config files ──────────────────────────────────────
  // go.mod → scan all .go files from root
  if (hints.hasGo) {
    try {
      const gomod = fs.readFileSync(path.join(workspaceRoot, 'go.mod'), 'utf8');
      const moduleLine = gomod.split('\n').find(l => l.startsWith('module '));
      if (moduleLine) {
        const globs = [`**/*.{${GO}}`];
        console.log(`[GraphMem] Detected Go project, scanning:`, globs);
        return globs;
      }
    } catch { /* fall through */ }
  }

  // Cargo.toml → Rust project, src/ is standard
  if (hints.hasRust && fs.existsSync(path.join(workspaceRoot, 'src'))) {
    const globs = [`src/**/*.{${SYSTEMS}}`];
    console.log(`[GraphMem] Detected Rust project, scanning:`, globs);
    return globs;
  }

  // pyproject.toml / setup.py → Python project
  if (hints.hasPython) {
    const pyDirs = ['src', 'app', 'lib', workspaceRoot]
      .map(d => path.join(workspaceRoot, d))
      .filter(d => fs.existsSync(d) && fs.statSync(d).isDirectory());

    const pkgDir = pyDirs.find(d => {
      // Look for a directory containing __init__.py = Python package root
      try {
        return fs.readdirSync(d).some(f =>
          fs.statSync(path.join(d, f)).isDirectory() &&
          fs.existsSync(path.join(d, f, '__init__.py'))
        );
      } catch { return false; }
    });

    if (pkgDir) {
      const rel   = path.relative(workspaceRoot, pkgDir).replace(/\\/g, '/') || '.';
      const globs = [`${rel}/**/*.{${PYTHON}}`];
      console.log(`[GraphMem] Detected Python project, scanning:`, globs);
      return globs;
    }

    // Fall back to scanning any .py files from root
    const globs = [`**/*.{${PYTHON}}`];
    console.log(`[GraphMem] Detected Python project (root scan):`, globs);
    return globs;
  }

  // ── 3. Known source directories present on disk ──────────────────────────────
  const found = SOURCE_CANDIDATES.filter(dir => {
    const full = path.join(workspaceRoot, dir);
    return fs.existsSync(full) &&
           fs.statSync(full).isDirectory() &&
           !ALWAYS_IGNORE.has(dir);
  });

  if (found.length > 0) {
    const globs = found.map(dir => `${dir}/**/*.${exts}`);
    // Deduplicate (ui/ may already be in found AND addAssetDirs)
    const unique = [...new Set(globs)];
    console.log(`[GraphMem] Detected source globs from directories:`, unique);
    return unique;
  }

  // ── 4. Root-level fallback ───────────────────────────────────────────────────
  console.log('[GraphMem] No source structure detected, scanning root');
  return [`**/*.${exts}`];
}