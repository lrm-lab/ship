import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MANIFEST_PATH } from "./manifest.js";

const config = loadConfig();
serve({ fetch: createApp(config).fetch, port: config.port }, ({ port }) => {
  console.log(`ship listening on port ${port}`);
  console.log(`Manifest: ${config.appOrigin}${MANIFEST_PATH}`);
});
