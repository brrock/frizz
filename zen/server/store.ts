// Frizz's one file of state: which T3 environment it controls, and the OAuth credential for it.
//
// It lives in `~/.frizz-zen/state.json` (or `$FRIZZ_ZEN_HOME`) with mode 0600, because it holds
// a bearer token that can start and steer agents on the user's machine.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface ZenState {
  /** The environment's MCP URL, e.g. `https://<environment-address>/mcp`. */
  mcpUrl?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  /** The project the board shows; absent means every project. */
  projectId?: string;
}

export class StateFile {
  readonly file: string;
  private state: ZenState;

  constructor(dir = process.env.FRIZZ_ZEN_HOME ?? path.join(os.homedir(), ".frizz-zen")) {
    this.file = path.join(dir, "state.json");
    this.state = read(this.file);
  }

  get(): Readonly<ZenState> {
    return this.state;
  }

  update(patch: Partial<ZenState>): void {
    this.state = { ...this.state, ...patch };
    for (const k of Object.keys(this.state) as (keyof ZenState)[]) {
      if (this.state[k] === undefined) delete this.state[k];
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

function read(file: string): ZenState {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ZenState;
  } catch {
    return {};
  }
}
