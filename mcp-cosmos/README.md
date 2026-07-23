# SBW Cosmos MCP (Claude Desktop)

Read-only Cosmos access for someone **without** Azure portal / `az login`.  
They put **your** Cosmos endpoint + key in their Claude config.

## Give the other person

1. Node.js 20+ installed  
2. A copy of this `mcp-cosmos` folder (or a zip / git clone of the repo)  
3. In that folder, run once:
   ```powershell
   cd mcp-cosmos
   npm install
   ```
4. Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sbw-cosmos": {
      "command": "node",
      "args": [
        "C:\\FULL\\PATH\\TO\\study_bid_workbench\\mcp-cosmos\\index.js"
      ],
      "env": {
        "COSMOS_ENDPOINT": "https://YOUR-ACCOUNT.documents.azure.com:443/",
        "COSMOS_KEY": "PASTE_PRIMARY_OR_READONLY_KEY",
        "COSMOS_DATABASE": "bd-budgets"
      }
    }
  }
}
```

5. Fully quit and reopen Claude Desktop.  
6. Ask: “List studies in Cosmos” or “Query the studies container”.

## Security

- Prefer a **read-only** key if Cosmos supports it for your account, or a dedicated key you can rotate.  
- This puts secrets on their laptop — treat like a password.  
- Firewall: their home/office IP must be allowed on Cosmos **Networking**, or allow Azure public access carefully. Key auth still fails if the firewall blocks them.

## What you copy from Azure

Cosmos DB account → **Keys**:
- URI → `COSMOS_ENDPOINT`  
- Primary or secondary key → `COSMOS_KEY`
