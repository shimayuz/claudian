import * as fs from 'fs';
import * as path from 'path';

import { getEnhancedPath } from '../../../utils/env';
import { parsePathEntries } from '../../../utils/path';

const BUNDLED_VENDOR_DIR = '.codex-vendor';

export function getCodexTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
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

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function getBundledCodexBinaryPath(
  baseDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const targetTriple = getCodexTargetTriple(platform, arch);
  if (!targetTriple) {
    return null;
  }

  const binaryName = platform === 'win32' ? 'codex.exe' : 'codex';
  const candidate = path.join(baseDir, BUNDLED_VENDOR_DIR, targetTriple, 'codex', binaryName);

  return isExistingFile(candidate) ? candidate : null;
}

export function findCodexBinaryPath(
  baseDir: string,
  additionalPath?: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const bundledBinary = getBundledCodexBinaryPath(baseDir, platform, arch);
  if (bundledBinary) {
    return bundledBinary;
  }

  const binaryNames = platform === 'win32' ? ['codex.exe', 'codex'] : ['codex'];
  const searchEntries = parsePathEntries(getEnhancedPath(additionalPath));

  for (const dir of searchEntries) {
    if (!dir) continue;
    for (const binaryName of binaryNames) {
      const candidate = path.join(dir, binaryName);
      if (isExistingFile(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}
