import { createApp } from "./app";
import { loadConfig } from "./config";
import { MANIFEST_PATH } from "./manifest";

const config = loadConfig();
const server = Bun.serve({ fetch: createApp(config).fetch, port: config.port });
console.log(`ship listening on port ${server.port}`);
console.log(`Manifest: ${config.appOrigin}${MANIFEST_PATH}`);
