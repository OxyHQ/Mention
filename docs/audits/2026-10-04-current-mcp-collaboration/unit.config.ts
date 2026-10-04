// Pure membership helper only: no app, database or global setup is imported.
// This scoped run does not replace the canonical backend/CI database suite.
export default {
  test: {
    environment: 'node',
    include: ['/home/nate/Oxy/Mention/.worktrees/1571-current-mcp-collaboration-20261004/packages/backend/src/__tests__/mcp/resolveMcpAutoAcceptIds.test.ts'],
    maxWorkers: 1,
  },
};
