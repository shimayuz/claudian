import { AgentManager } from '@/providers/claude/agents';
import { buildAgentFromFrontmatter, parseAgentFile } from '@/providers/claude/agents';

describe('providers/claude/agents index', () => {
  it('re-exports runtime symbols', () => {
    expect(AgentManager).toBeDefined();
    expect(buildAgentFromFrontmatter).toBeDefined();
    expect(parseAgentFile).toBeDefined();
  });
});
