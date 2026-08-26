import path from "node:path";
import { buildServer } from "./server.js";
import { loadConfig, loadLocalEnvFile } from "./config.js";

loadLocalEnvFile(path.join(import.meta.dirname, "..", ".env"));
const config = loadConfig();
const app = await buildServer({ config });
await app.listen({ host: config.host, port: config.port });
console.log(`SignalFold AI Insights sidecar: http://${config.host}:${config.port}`);
