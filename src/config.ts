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
    if (issuer.endsWith("/")) throw new Error(`${at}.issuer must not end with a slash`);
    requireSecureUrl(`${at}.issuer`, issuer);
    if (seen.has(issuer)) throw new Error(`${name} lists the issuer ${issuer} twice`);
    seen.add(issuer);
    return { issuer, clientId: clientId.trim() };
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
  if (requireSecureUrl("APP_ORIGIN", appOrigin).pathname !== "/") {
    throw new Error("APP_ORIGIN must be an origin, without a path");
  }
  return {
    trustedIssuers,
    appOrigin,
    port: Number(env.PORT || 3000),
    host: env.HOST?.trim() || "0.0.0.0",
    databaseUrl,
  };
}
