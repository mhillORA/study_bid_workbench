# SBW Cosmos MCP (Claude Desktop)

## Easiest (Windows) — for the other person

1. Install [Node.js 20+](https://nodejs.org)
2. Get this `mcp-cosmos` folder (zip from Matt)
3. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install-for-claude.ps1
   ```
4. Paste the Cosmos URI + key when asked
5. Fully quit Claude Desktop → reopen
6. Ask: “List studies in Cosmos”

No hand-editing JSON paths.

## Manual config (optional)

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sbw-cosmos": {
      "command": "node",
      "args": ["C:\\FULL\\PATH\\TO\\mcp-cosmos\\index.js"],
      "env": {
        "COSMOS_ENDPOINT": "https://YOUR-ACCOUNT.documents.azure.com:443/",
        "COSMOS_KEY": "PASTE_KEY",
        "COSMOS_DATABASE": "bd-budgets"
      }
    }
  }
}
```

Then `npm install` once in this folder.

## What Matt sends them

- This folder (zip)
- Cosmos **URI** + **key** (Azure → Cosmos → Keys)
- Note: their IP may need allowlisting on Cosmos **Networking**

## Security

Keys on their laptop = treat like a password. Prefer a rotatable key. MCP is read-only (SELECT only).
