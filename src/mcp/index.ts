import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb } from "../store/db.js";
import { createSynergyServer } from "./server.js";

/**
 * Runtime entry point: open the local SQLite store, build the synergy MCP
 * server over it, and serve it over stdio. This server reads only the
 * store; it never calls the Parity API. The stdio transport keeps the
 * process alive while its parent's pipe is open; closing stdin ends the
 * session.
 */
async function main(): Promise<void> {
  const db = openDb();
  const server = createSynergyServer({ db });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
