import { PluginManager } from '@/providers/claude/plugins';

describe('providers/claude/plugins index', () => {
  it('re-exports runtime symbols', () => {
    expect(PluginManager).toBeDefined();
  });
});
