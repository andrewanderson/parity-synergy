import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb, storeFileState } from "../store/db.js";
import { createSynergyServer } from "./server.js";

/**
 * Runtime entry point: open the local SQLite store, build the synergy MCP
 * server over it, and serve it over stdio. This server reads only the
 * store; it never calls the Parity API. The stdio transport keeps the
 * process alive while its parent's pipe is open; closing stdin ends the
 * session.
 *
 * stdout carries the protocol, so a store this process had to create is
 * reported on stderr: a client pointed at a typo'd path gets the same
 * warning a CLI user gets, without corrupting the session.
 */
async function main(): Promise<void> {
  const store = storeFileState();
  const db = openDb();
  if (!store.existed) {
    console.error(`created a new empty store at ${store.path}`);
  }
  const server = createSynergyServer({ db });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
