# Raywake MCP

500+ AI image, video and audio models in Claude, ChatGPT, Cursor and any MCP client.

An open-source TypeScript MCP server for [Raywake](https://raywake.si). Use the hosted connector at `https://mcp.raywake.com/v1` with nothing to install, or run this package locally over stdio with `npx` (Node.js 20 or later).

## Get an API key

Create a key at [raywake.si/api-keys](https://raywake.si/api-keys). Enable `models:read`, `generate`, `jobs:read`, and `wallet:read` for all tools (`upload_file` needs `generate`, `list_media` needs `jobs:read`). Add USD balance at [raywake.si/billing](https://raywake.si/billing) when you want to generate. Browsing, uploads, quotes and job checks are free.

Replace `YOUR_RAYWAKE_API_KEY` in the configurations below. Keep your key private and keep configuration files containing it out of version control.

## Claude Code

```sh
claude mcp add raywake -e RAYWAKE_API_KEY=YOUR_RAYWAKE_API_KEY -- npx -y @raywake/mcp
```

## Cursor

Add to `~/.cursor/mcp.json` (or your project's `.cursor/mcp.json`), then enable Raywake in MCP settings:

```json
{
  "mcpServers": {
    "raywake": {
      "command": "npx",
      "args": ["-y", "@raywake/mcp"],
      "env": { "RAYWAKE_API_KEY": "YOUR_RAYWAKE_API_KEY" }
    }
  }
}
```

## Claude Desktop

Open Settings > Developer > Edit Config and add to `claude_desktop_config.json`. Restart Claude Desktop after saving.

```json
{
  "mcpServers": {
    "raywake": {
      "command": "npx",
      "args": ["-y", "@raywake/mcp"],
      "env": { "RAYWAKE_API_KEY": "YOUR_RAYWAKE_API_KEY" }
    }
  }
}
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`, then refresh MCP servers:

```json
{
  "mcpServers": {
    "raywake": {
      "command": "npx",
      "args": ["-y", "@raywake/mcp"],
      "env": { "RAYWAKE_API_KEY": "YOUR_RAYWAKE_API_KEY" }
    }
  }
}
```

## VS Code

Add to `.vscode/mcp.json`. VS Code prompts for your key and stores the input securely:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "raywake-api-key",
      "description": "Raywake API key",
      "password": true
    }
  ],
  "servers": {
    "raywake": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@raywake/mcp"],
      "env": { "RAYWAKE_API_KEY": "${input:raywake-api-key}" }
    }
  }
}
```

These JSON examples are complete minimal configurations. Merge the `raywake` entry into an existing configuration to retain your other servers. On Windows, if the client cannot start `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "@raywake/mcp"]`.

## Remote (no install)

Raywake also hosts the same tools over Streamable HTTP:

```text
https://mcp.raywake.com/v1
```

- **Claude.ai / Claude Desktop:** Settings > Connectors > Add custom connector, paste the URL, then sign in with your Raywake account.
- **ChatGPT:** Settings > Connectors > Create (developer mode), paste the URL, then sign in with your Raywake account.
- **Claude Code:** `claude mcp add --transport http raywake https://mcp.raywake.com/v1`, then run `/mcp` to sign in. To use an API key instead: add `--header "Authorization: Bearer YOUR_RAYWAKE_API_KEY"`.

OAuth connections set a per-generation spending limit at sign-in and expire after 30 days; you can disconnect them at any time in Raywake settings.

## Tools

| Tool | Cost | Purpose |
| --- | --- | --- |
| `search_models` | Free | Search by `query`, `category`, `modality` (`image`, `video`, `audio`) and `page` (starts at 1; 20 results per page) |
| `list_categories` | Free | List available categories |
| `get_model` | Free | Read the exact input schema and indicative starting price in USD |
| `quote` | Free | Price an exact `model` and `input`; returns `quote_id`, `price_usd`, `expires_at` |
| `generate` | Paid | Submit the approved exact `model`, `input`, `quote_id`; optional `idempotency_key` for recovery |
| `get_job` | Free | Read `job_id`, outputs and status; optional `wait_seconds` from 0 to 45 |
| `list_jobs` | Free | List account history; optional `limit` (1–500), `offset`, `status` |
| `get_account` | Free | Read available, reserved and debt balances in USD |
| `upload_file` | Free | Upload one local image, video or audio file by `path` to your private Raywake files; returns the `url` to put into a model's media input |
| `list_media` | Free | List your uploaded files, newest first, with fresh links; optional `page` (20 per page) |
| `get_playbook` | Free | Read the short workflow, spending and file rules |

`search_models` maps `query` to the API's `search`, and `page` to `limit`/`offset`. Because the API has no modality parameter, modality matches category/tags locally before pagination. Some models may match multiple modalities. `get_model` preserves the gateway's `openapi` schema and derives a starting price from its retail price guide when necessary. Starting prices are per the returned unit, such as image or second; they are not a quote for a complete run. An unavailable starting price is returned as `null`.

## Example prompts

- "Find image models for product photography and compare their starting prices in USD."
- "Show the schema for this model, prepare my input and get a quote. Ask me before spending anything."
- "Animate ~/Pictures/product.png into a short video. Show me the price before generating."
- "Quote a short video using this public HTTPS image URL. Show me the price before generating."
- "I approve this quoted price and input. Generate it, then check the existing job until it finishes."
- "Show my recent jobs and retrieve the newest result."
- "What is my available USD balance?"

## What costs money

Only `generate` can spend your Raywake balance. Search, schemas, uploads, quotes, wallet reads and job polling are free. The assistant must follow:

1. Search for a model and read its schema with `get_model`.
2. Call `quote` with the complete input.
3. Show you the USD price, expiry and whether it is a usage-based maximum reservation, and get your approval.
4. Call `generate` with that exact model, input and quote ID.
5. Continue with `get_job`; polling never starts another generation.

The quote's `settles_on_usage` flag indicates a maximum reservation: actual billed usage is charged and unused balance is returned. For an expired quote or changed input, obtain a new quote and approval. If balance is insufficient, [top up](https://raywake.si/billing).

Approval is a rule communicated to the assistant through descriptions and the built-in playbook; the server cannot independently verify a conversation's human approval. Your MCP client's confirmation settings should require approval for the paid `generate` tool. Quote ownership, expiry and exact input binding are enforced by Raywake's gateway, with additional matching checks for quotes known to this process.

### Waiting and safe retries

`generate` waits for up to 45 seconds including submission, then returns the known `job_id`, latest status and its generated `idempotency_key`. If polling fails, it retains the job reference. Continue using `get_job` with `wait_seconds` up to 45. Terminal states are `succeeded`, `failed`, `needs_review`, `submission_unknown`, and `needs_reconciliation`. Review and reconciliation states require attention; do not submit a replacement run automatically.

Save the `idempotency_key`, including from an error result. If the submission response is lost, retry `generate` with the same key, model, input and quote ID. The gateway returns the existing job for an exact retry, including after quote expiry. Never use a new key to recover an uncertain submission. Within a running server, repeating the same generation request also reuses its saved key. After restarting, supply the saved key; the gateway remains the authority for recovery of quotes no longer in local memory. Keys and quote fingerprints are held only in memory. If the entire tool response and process are lost, use `list_jobs` to find the existing job before doing anything that may spend again.

## Media inputs

To use a file from your computer, ask the assistant to use it; it calls `upload_file` with the file's path. In one call the tool checks the file, uploads the unchanged bytes to your private Raywake files and returns an owned `url`. The assistant puts that `url` into the model's image, video or audio input and then quotes. The file is never resized, re-encoded or embedded as base64, and it is never sent anywhere but Raywake.

| Type | Limit |
| --- | --- |
| JPEG, PNG, WebP | 25 MB |
| MP4, MOV | 200 MB |
| WebM | 100 MB |
| MP3, WAV | 50 MB |

The type is detected from the file's own bytes, not just its extension. Per account, at most 3 uploads can be unfinished at once and 250 MB can be stored. Files are kept for 30 days; a returned link stays valid for 7 days, and `list_media` returns fresh links. Large files are streamed from disk, not loaded into memory.

**Which files can be read.** By default `upload_file` reads only files inside your home folder and the folder the server was started in (ignored when that is the filesystem root or a folder above your home). Symlinks are resolved before the check. Files in hidden folders such as `~/.ssh`, `~/.aws` or `~/.config`, and anything that is not one of the types above, are refused before the file is opened. Set `RAYWAKE_UPLOAD_ROOTS` to replace the allowed folders. Errors tell the assistant what to do next: file not found, folder not allowed, wrong type, too large, upload limit reached, upload failed (retry), or an API key without the `generate` permission.

A public HTTPS link can still go into a model input directly. Importing a web link into your Raywake files and reusing an earlier result as an uploaded file are available only through the hosted connector signed in with your Raywake account: the API rejects those two operations for API keys, so this package has no tools for them. Output links may be temporary; call `get_job` again to retrieve current links.

## Configuration

| Environment variable | Required | Default |
| --- | --- | --- |
| `RAYWAKE_API_KEY` | Yes | None; sent as a Bearer token |
| `RAYWAKE_API_BASE` | No | `https://api.raywake.com` |
| `RAYWAKE_UPLOAD_ROOTS` | No | Your home folder and the working folder. Absolute folders separated by `:` (`;` on Windows); `~` means your home folder. Hidden folders inside them stay refused |

The base override must use HTTPS, except HTTP on localhost for local mocks. It must not contain credentials, a query or a fragment. Only use an override you trust: it receives your API key. Redirects are rejected. The server reserves stdout for MCP and never logs the key or raw upstream error bodies.

## Privacy

Prompts and inputs go to Raywake and the selected model provider to fulfil your request. Your MCP client also handles the conversation and tool results. Do not include secrets in model inputs. This local package does not add analytics or write prompts, keys, quotes or results to disk. `upload_file` reads only the file you ask it to upload, and only from the allowed folders. Client logging and the services' retention policies apply separately.

## Development

```sh
npm install
npm run build
npm test
npm run smoke
```

`npm test` builds the CLI, uses Vitest with a mocked fetch and dummy credentials, and checks real stdio tool discovery without API access. The separate `npm run smoke` SDK test starts its own HTTP server on `127.0.0.1` with a dummy key, launches the compiled CLI, lists all eleven tools and exercises discovery, file upload to a local stand-in for the signed upload link, quote, generation and job retrieval. Neither command calls `api.raywake.com`. The HTTP smoke requires permission to bind a local port; restricted sandboxes may reject it with `EPERM`.

To connect an MCP client to this unpublished checkout, replace the `npx` configuration with `"command": "node"` and `"args": ["/absolute/path/to/raywake-mcp/dist/index.js"]`; keep the same environment configuration. For a terminal launch after building:

```sh
RAYWAKE_API_KEY=YOUR_RAYWAKE_API_KEY node dist/index.js
```

`server.json` is the metadata published to the [official MCP Registry](https://registry.modelcontextprotocol.io) as `si.raywake/mcp`. Release and registry publication are separate manual steps. The npm package's `mcpName` matches `si.raywake/mcp`; version fields must stay in sync.

## License

[MIT](LICENSE), copyright Raywake.
