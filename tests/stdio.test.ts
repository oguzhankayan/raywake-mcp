import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

it('launches the built executable and discovers eleven tools over real stdio without network', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { RAYWAKE_API_KEY: 'dummy-stdio-key', RAYWAKE_API_BASE: 'http://127.0.0.1:1' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['generate', 'upload_file', 'list_media']));
    const playbook = await client.callTool({ name: 'get_playbook', arguments: {} });
    expect(playbook.isError).not.toBe(true);
    expect(playbook.structuredContent).toMatchObject({ guide: expect.stringContaining('explicit approval') });
    expect(stderr).not.toContain('dummy-stdio-key');
  } finally {
    await client.close();
    await transport.close();
  }
});
