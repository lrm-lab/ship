/** @typedef {{ issuer: string, clientId: string, appOrigin: string, port: number }} Config */

/**
 * @param {Record<string, string | undefined>} env
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  const need = (name) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
    return value;
  };
  const issuer = need("COFORGE_ISSUER");
  const appOrigin = need("APP_ORIGIN");
  if (issuer.endsWith("/")) throw new Error("COFORGE_ISSUER must not end with a slash");
  for (const [name, value] of [["COFORGE_ISSUER", issuer], ["APP_ORIGIN", appOrigin]]) {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error(`${name} must be https (http is accepted only for localhost)`);
    }
  }
  if (new URL(appOrigin).pathname !== "/") throw new Error("APP_ORIGIN must be an origin, without a path");
  return { issuer, clientId: need("COFORGE_CLIENT_ID"), appOrigin, port: Number(env.PORT || 3000) };
}
