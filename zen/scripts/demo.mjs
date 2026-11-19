// `pnpm demo`: Frizz against a stand-in T3 Code, so you can try the board without one.
//
// Starts the mock environment (same MCP tools, same OAuth sign-in, approved at once) and a Frizz
// with its own throwaway state, then prints the address to open. Nothing touches ~/.frizz-zen.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../mock/t3-mock.ts";
import { startServer } from "../server/app.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "dist", "web");
if (!fs.existsSync(path.join(web, "index.html"))) {
  console.log("Building the page…");
  const r = spawnSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const mock = await startMock({ port: Number(process.env.MOCK_PORT ?? 4778), runMs: 4000 });
const home = fs.mkdtempSync(path.join(os.tmpdir(), "frizz-zen-demo-"));
const zen = await startServer({ port: Number(process.env.PORT ?? 4777), home, staticDir: web });

console.log(`\nThe stand-in T3 Code: ${mock.mcpUrl}`);
console.log(`Frizz:                http://localhost:${zen.port}/?mcp=${encodeURIComponent(mock.mcpUrl)}\n`);
console.log('Prompts with "ask" end on a question, prompts with "fail" fail. Ctrl-C to stop.');

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await zen.close();
    await mock.close();
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(0);
  });
}
