import esbuild from 'esbuild';
import path from 'path';
import process from 'process';
import builtins from 'builtin-modules';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readFileSync,
  rmSync,
} from 'fs';

// Load .env.local if it exists
if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^=]+)=["']?(.+?)["']?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const prod = process.argv[2] === 'production';

const CODEX_PLATFORM_PACKAGES = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

function getCodexTargetTriple(platform = process.platform, arch = process.arch) {
  switch (platform) {
    case 'linux':
    case 'android':
      return arch === 'x64'
        ? 'x86_64-unknown-linux-musl'
        : arch === 'arm64'
          ? 'aarch64-unknown-linux-musl'
          : null;

    case 'darwin':
      return arch === 'x64'
        ? 'x86_64-apple-darwin'
        : arch === 'arm64'
          ? 'aarch64-apple-darwin'
          : null;

    case 'win32':
      return arch === 'x64'
        ? 'x86_64-pc-windows-msvc'
        : arch === 'arm64'
          ? 'aarch64-pc-windows-msvc'
          : null;

    default:
      return null;
  }
}

function getCodexVendorSource() {
  const targetTriple = getCodexTargetTriple();
  if (!targetTriple) {
    return null;
  }

  const packageName = CODEX_PLATFORM_PACKAGES[targetTriple];
  if (!packageName) {
    return null;
  }

  const vendorDir = path.join('node_modules', packageName, 'vendor', targetTriple);
  if (!existsSync(vendorDir)) {
    return null;
  }

  return { targetTriple, vendorDir };
}

function syncCodexVendor(outputDir) {
  const vendorRoot = path.join(outputDir, '.codex-vendor');
  rmSync(vendorRoot, { recursive: true, force: true });

  const source = getCodexVendorSource();
  if (!source) {
    return false;
  }

  mkdirSync(vendorRoot, { recursive: true });
  cpSync(source.vendorDir, path.join(vendorRoot, source.targetTriple), { recursive: true });
  return true;
}

const patchCodexSdkImportMeta = {
  name: 'patch-codex-sdk-import-meta',
  setup(build) {
    build.onLoad(
      { filter: /[\\/]node_modules[\\/]@openai[\\/]codex-sdk[\\/]dist[\\/]index\.js$/ },
      async (args) => {
        const contents = await fsPromises.readFile(args.path, 'utf8');
        return {
          contents: contents.replace('createRequire(import.meta.url)', 'createRequire(__filename)'),
          loader: 'js',
        };
      },
    );
  },
};

// Obsidian plugin folder path (set via OBSIDIAN_VAULT env var or .env.local)
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT;
const OBSIDIAN_PLUGIN_PATH = OBSIDIAN_VAULT && existsSync(OBSIDIAN_VAULT)
  ? path.join(OBSIDIAN_VAULT, '.obsidian', 'plugins', 'claudian')
  : null;

// Plugin to copy built files to Obsidian plugin folder
const copyToObsidian = {
  name: 'copy-to-obsidian',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;

      const hasCodexVendor = syncCodexVendor(process.cwd());

      if (!OBSIDIAN_PLUGIN_PATH) return;

      if (!existsSync(OBSIDIAN_PLUGIN_PATH)) {
        mkdirSync(OBSIDIAN_PLUGIN_PATH, { recursive: true });
      }

      const files = ['main.js', 'manifest.json', 'styles.css'];
      for (const file of files) {
        if (existsSync(file)) {
          copyFileSync(file, path.join(OBSIDIAN_PLUGIN_PATH, file));
          console.log(`Copied ${file} to Obsidian plugin folder`);
        }
      }

      const pluginVendorRoot = path.join(OBSIDIAN_PLUGIN_PATH, '.codex-vendor');
      rmSync(pluginVendorRoot, { recursive: true, force: true });

      if (hasCodexVendor && existsSync('.codex-vendor')) {
        cpSync('.codex-vendor', pluginVendorRoot, { recursive: true });
        console.log('Copied .codex-vendor to Obsidian plugin folder');
      }
    });
  }
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  plugins: [patchCodexSdkImportMeta, copyToObsidian],
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
    ...builtins.map(m => `node:${m}`),
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
