import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  findCodexBinaryPath,
  getBundledCodexBinaryPath,
  getCodexTargetTriple,
} from '@/providers/codex/runtime/CodexBinaryLocator';

describe('CodexBinaryLocator', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-binary-locator-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('maps supported platform and arch combinations to Codex target triples', () => {
    expect(getCodexTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(getCodexTargetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(getCodexTargetTriple('linux', 'x64')).toBe('x86_64-unknown-linux-musl');
    expect(getCodexTargetTriple('win32', 'arm64')).toBe('aarch64-pc-windows-msvc');
    expect(getCodexTargetTriple('darwin', 'ia32')).toBeNull();
  });

  it('prefers a bundled Codex binary next to the plugin bundle', () => {
    const bundledBinary = path.join(
      tempDir,
      '.codex-vendor',
      'aarch64-apple-darwin',
      'codex',
      'codex',
    );
    fs.mkdirSync(path.dirname(bundledBinary), { recursive: true });
    fs.writeFileSync(bundledBinary, '');

    expect(getBundledCodexBinaryPath(tempDir, 'darwin', 'arm64')).toBe(bundledBinary);
    expect(findCodexBinaryPath(tempDir, undefined, 'darwin', 'arm64')).toBe(bundledBinary);
  });

  it('falls back to a codex executable on PATH when no bundled binary exists', () => {
    const pathDir = path.join(tempDir, 'bin');
    const pathBinary = path.join(pathDir, 'codex');
    fs.mkdirSync(pathDir, { recursive: true });
    fs.writeFileSync(pathBinary, '');

    expect(findCodexBinaryPath(tempDir, pathDir, 'darwin')).toBe(pathBinary);
  });
});
