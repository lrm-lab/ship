import { createApp } from "./app";
import { loadConfig } from "./config";
import { MANIFEST_PATH } from "./manifest";
import { createDatabase } from "./store/database";
import { createShutdown } from "./shutdown";
import { createPrismaReleaseStore } from "./store/prisma-release-store";

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const app = createApp(config, { store: createPrismaReleaseStore(database.client) });
const server = Bun.serve({ fetch: app.fetch, hostname: config.host, port: config.port });
console.log(`ship listening on ${server.hostname}:${server.port}`);
console.log(`Manifest: ${config.appOrigin}${MANIFEST_PATH}`);

// Stop taking requests, let the ones in flight finish, then close the connection pool.
const shutdown = createShutdown({
  steps: [
    { name: "stop server", run: () => server.stop() },
    { name: "close database", run: () => database.close() },
  ],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
