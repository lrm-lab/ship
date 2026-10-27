/** A CoForge deployment Ship trusts, with the client ID it registered Ship under there. */
export type TrustedIssuer = { issuer: string; clientId: string };

export type Config = {
  trustedIssuers: TrustedIssuer[];
  appOrigin: string;
  port: number;
  /** The interface to listen on. */
  host: string;
  databaseUrl: string;
};

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Throws unless `value` is an https URL, or an http URL on a loopback host. */
function requireSecureUrl(name: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL`);
  }
  const loopback = LOOPBACK_HOSTS.includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${name} must be https (http is accepted only for localhost)`);
  }
  return url;
}

function parseTrustedIssuers(raw: string): TrustedIssuer[] {
  const name = "SHIP_TRUSTED_ISSUERS";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of { "issuer", "clientId" }`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${name} must be a non-empty JSON array of { "issuer", "clientId" }`);
  }
  const seen = new Set<string>();
  return parsed.map((entry: unknown, index) => {
    const { issuer, clientId } = (entry ?? {}) as Record<string, unknown>;
    const at = `${name}[${index}]`;
    if (typeof issuer !== "string" || !issuer.trim())
      throw new Error(`${at}.issuer must be a non-empty string`);
    if (typeof clientId !== "string" || !clientId.trim()) {
      throw new Error(`${at}.clientId must be a non-empty string`);
    }
    const trimmed = issuer.trim();
    if (trimmed.endsWith("/")) throw new Error(`${at}.issuer must not end with a slash`);
    const url = requireSecureUrl(`${at}.issuer`, trimmed);
    // A token's `iss` is compared as a string, so the issuer must be written the way a URL
    // serializes (lower-case host, no default port, no dot segments); an origin without a path
    // serializes with a slash that the issuer, by the rule above, does not have.
    if ((url.href !== trimmed && url.href !== `${trimmed}/`) || url.search || url.hash) {
      throw new Error(
        `${at}.issuer must be a plain URL without a query or fragment, written as ${url.href.replace(/\/$/, "")}`,
      );
    }
    if (seen.has(trimmed)) throw new Error(`${name} lists the issuer ${trimmed} twice`);
    seen.add(trimmed);
    return { issuer: trimmed, clientId: clientId.trim() };
  });
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
    return value;
  };
  const trustedIssuers = parseTrustedIssuers(need("SHIP_TRUSTED_ISSUERS"));
  const appOrigin = need("APP_ORIGIN");
  const databaseUrl = need("DATABASE_URL");
  const origin = requireSecureUrl("APP_ORIGIN", appOrigin);
  if (origin.pathname !== "/" || /[?#]/.test(appOrigin) || origin.username || origin.password) {
    throw new Error("APP_ORIGIN must be an origin: no path, query, fragment or credentials");
  }
  return {
    trustedIssuers,
    // The origin, not the text: a trailing slash would double up in the URLs built from it.
    appOrigin: origin.origin,
    port: Number(env.PORT || 3000),
    host: env.HOST?.trim() || "0.0.0.0",
    databaseUrl,
  };
}
