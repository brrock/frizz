// `pnpm dev`: the API on :4777 and the page with hot reload on :5173. Open :5173.
// The OAuth redirect comes back through Vite's proxy, so sign-in works from the dev page too.

import { spawn } from "node:child_process";

const env = { ...process.env, FRIZZ_ZEN_ORIGIN: "http://localhost:5173" };
const procs = [
  spawn(process.execPath, ["server/main.ts", "--api-only"], { stdio: "inherit", env }),
  spawn("pnpm", ["exec", "vite"], { stdio: "inherit", env }),
];
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => code && (stop(), process.exit(code)));
