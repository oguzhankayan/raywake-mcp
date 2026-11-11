#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RaywakeClient } from './client.js';
import { createMcpServer } from './server.js';
import { parseRoots, ROOTS_ENV } from './upload.js';

try {
  const client = new RaywakeClient({ apiKey: process.env.RAYWAKE_API_KEY ?? '', baseUrl: process.env.RAYWAKE_API_BASE,
    uploadRoots: parseRoots(process.env[ROOTS_ENV]) });
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
} catch {
  // stdout is reserved for MCP. Do not print credentials or raw errors.
  console.error('Unable to start Raywake MCP. Set RAYWAKE_API_KEY (https://raywake.si/api-keys), check RAYWAKE_API_BASE, and use Node.js 20+.');
  process.exitCode = 1;
}
