// The OAuth client Frizz presents to T3 Connect.
//
// T3 Code's MCP sign-in is standard MCP OAuth: protected-resource metadata, dynamic client
// registration at `/oauth/mcp/register`, PKCE (S256), public client (`token_endpoint_auth_method:
// none`), and an `authorization_code` grant only — no refresh token; access lasts 30 days. Its
// registration accepts an `https` redirect, or `http` on localhost, 127.0.0.1 or [::1], which is
// why Frizz's callback is on the loopback origin it serves.
//
// The MCP SDK drives the flow; this class only persists what it hands over, and, instead of
// opening a browser itself, keeps the authorization URL so the page can offer it as a link.

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { StateFile } from "./store.ts";

export class ZenOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK asks for a sign-in; the page shows it until the callback lands. */
  pendingAuthUrl: string | null = null;

  private readonly store: StateFile;
  private readonly callbackUrl: string;

  constructor(store: StateFile, callbackUrl: string) {
    this.store = store;
    this.callbackUrl = callbackUrl;
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Frizz",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.store.get().client;
    // A client registered for another callback (Frizz moved port) cannot finish a sign-in here.
    const uris = (client as { redirect_uris?: string[] } | undefined)?.redirect_uris;
    if (client && uris && !uris.includes(this.callbackUrl)) return undefined;
    return client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.store.update({ client });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.get().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.pendingAuthUrl = null;
    this.store.update({ tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.pendingAuthUrl = url.toString();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.update({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.store.get().codeVerifier;
    if (!v) throw new Error("No sign-in is in progress. Start it again from Frizz.");
    return v;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all") this.store.update({ client: undefined, tokens: undefined, codeVerifier: undefined });
    else if (scope === "client") this.store.update({ client: undefined });
    else if (scope === "tokens") this.store.update({ tokens: undefined });
    else if (scope === "verifier") this.store.update({ codeVerifier: undefined });
  }
}
