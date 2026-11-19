// `pnpm start`: serve the built page and the API on one loopback port.
//
//   PORT=4777 pnpm start
//
// Then open http://localhost:4777 and paste your T3 Code environment's MCP URL.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./app.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4777);
const apiOnly = process.argv.includes("--api-only");

const s = await startServer({
  port,
  staticDir: apiOnly ? undefined : path.join(here, "..", "dist", "web"),
  publicOrigin: process.env.FRIZZ_ZEN_ORIGIN,
});

console.log(`Frizz is listening on http://localhost:${s.port}`);
const state = s.t3.state;
if (state.phase === "unconfigured") console.log("Open it and paste your T3 Code MCP URL to connect.");

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void s.close().then(() => process.exit(0)));
}
