#!/usr/bin/env node
/**
 * Read-only Cosmos MCP for Claude Desktop.
 * Auth: COSMOS_ENDPOINT + COSMOS_KEY in the Claude mcp config env block.
 * No Azure CLI / Entra required on the other person's machine.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CosmosClient } from "@azure/cosmos";

function requiredEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function getClient() {
  const endpoint = requiredEnv("COSMOS_ENDPOINT");
  const key = requiredEnv("COSMOS_KEY");
  return new CosmosClient({ endpoint, key });
}

function defaultDbName() {
  return (process.env.COSMOS_DATABASE || "bd-budgets").trim();
}

const server = new Server(
  { name: "sbw-cosmos-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "cosmos_list_databases",
      description: "List databases in the Cosmos account.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "cosmos_list_containers",
      description: "List containers in a database (defaults to COSMOS_DATABASE / bd-budgets).",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string", description: "Database id" }
        },
        additionalProperties: false
      }
    },
    {
      name: "cosmos_query",
      description:
        "Run a read-only Cosmos SQL query. Prefer SELECT. Default database is bd-budgets.",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string" },
          container: { type: "string" },
          query: { type: "string", description: "Cosmos SQL, e.g. SELECT TOP 20 * FROM c" },
          maxItems: { type: "number", description: "Max items to return (default 50, max 200)" }
        },
        required: ["container", "query"],
        additionalProperties: false
      }
    },
    {
      name: "cosmos_get_item",
      description: "Get one document by id and partition key.",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string" },
          container: { type: "string" },
          id: { type: "string" },
          partitionKey: { type: "string", description: "Partition key value (often studyId)" }
        },
        required: ["container", "id", "partitionKey"],
        additionalProperties: false
      }
    },
    {
      name: "cosmos_list_studies",
      description: "List study documents from the studies container (bd-budgets).",
      inputSchema: {
        type: "object",
        properties: {
          maxItems: { type: "number" }
        },
        additionalProperties: false
      }
    }
  ]
}));

function textResult(obj) {
  return {
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }]
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  try {
    const client = getClient();

    if (name === "cosmos_list_databases") {
      const { resources } = await client.databases.readAll().fetchAll();
      return textResult(resources.map((d) => ({ id: d.id })));
    }

    if (name === "cosmos_list_containers") {
      const dbName = (args.database || defaultDbName()).trim();
      const { resources } = await client.database(dbName).containers.readAll().fetchAll();
      return textResult({ database: dbName, containers: resources.map((c) => ({ id: c.id })) });
    }

    if (name === "cosmos_query") {
      const dbName = (args.database || defaultDbName()).trim();
      const container = String(args.container || "").trim();
      const query = String(args.query || "").trim();
      if (!container || !query) throw new Error("container and query are required");
      if (/^\s*(insert|update|delete|upsert|replace|create)\b/i.test(query)) {
        throw new Error("Write queries are blocked. Use SELECT only.");
      }
      let maxItems = Number(args.maxItems);
      if (!Number.isFinite(maxItems) || maxItems <= 0) maxItems = 50;
      maxItems = Math.min(200, Math.floor(maxItems));

      const { resources } = await client
        .database(dbName)
        .container(container)
        .items.query(query, { maxItemCount: maxItems })
        .fetchAll();

      return textResult({
        database: dbName,
        container,
        count: resources.length,
        items: resources.slice(0, maxItems)
      });
    }

    if (name === "cosmos_get_item") {
      const dbName = (args.database || defaultDbName()).trim();
      const container = String(args.container || "").trim();
      const id = String(args.id || "").trim();
      const partitionKey = String(args.partitionKey || "").trim();
      const { resource } = await client
        .database(dbName)
        .container(container)
        .item(id, partitionKey)
        .read();
      return textResult(resource || { note: "not found" });
    }

    if (name === "cosmos_list_studies") {
      let maxItems = Number(args.maxItems);
      if (!Number.isFinite(maxItems) || maxItems <= 0) maxItems = 50;
      maxItems = Math.min(200, Math.floor(maxItems));
      const dbName = defaultDbName();
      const { resources } = await client
        .database(dbName)
        .container("studies")
        .items.query(
          {
            query:
              "SELECT TOP @n c.id, c.studyId, c.clientName, c.title, c.protocol, c.phase, c.status, c.therapeuticArea FROM c WHERE c.docType = @t",
            parameters: [
              { name: "@n", value: maxItems },
              { name: "@t", value: "study" }
            ]
          },
          { maxItemCount: maxItems }
        )
        .fetchAll();
      return textResult({ database: dbName, count: resources.length, studies: resources });
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: String(err.message || err) }]
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
