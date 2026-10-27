import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";

/** A stand-in for one CoForge deployment: its issuer URL, the client ID Ship has there, and its signing key. */
export type TestIssuer = {
  issuer: string;
  clientId: string;
  privateKey: CryptoKey;
  /** The JSON a real issuer serves at `<issuer>/jwks`. */
  jwks: { keys: JWK[] };
  keySet: JWTVerifyGetKey;
};

export async function createTestIssuer(issuer: string, clientId: string): Promise<TestIssuer> {
  const pair = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };
  const jwks = { keys: [jwk] };
  return { issuer, clientId, privateKey: pair.privateKey, jwks, keySet: createLocalJWKSet(jwks) };
}

export type AgentTokenOptions = {
  /** Overrides, to forge a token that should be refused. */
  iss?: string;
  aud?: string;
  sub?: string;
  claims?: Record<string, unknown>;
  key?: CryptoKey;
  typ?: string;
  expiresIn?: string | number;
};

/** An Agent access token shaped like docs/authorization-server: RFC 9068, ES256, typ at+jwt, 5 minutes. */
export function signAgentToken(
  issuer: TestIssuer,
  { iss, aud, sub, claims, key, typ = "at+jwt", expiresIn = "5m" }: AgentTokenOptions = {},
): Promise<string> {
  return new SignJWT({
    client_id: aud ?? issuer.clientId,
    type: "agent",
    workspace_id: "w1",
    workspace_slug: "acme",
    scope: "openid profile identity",
    ...claims,
  })
    .setProtectedHeader({ alg: "ES256", kid: "k1", typ })
    .setIssuer(iss ?? issuer.issuer)
    .setAudience(aud ?? issuer.clientId)
    .setSubject(sub ?? "agent-1")
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setJti(crypto.randomUUID())
    .sign(key ?? issuer.privateKey);
}

/** The value of SHIP_TRUSTED_ISSUERS that trusts these issuers, each with its own client ID. */
export const trustedIssuersEnv = (...issuers: TestIssuer[]): string =>
  JSON.stringify(issuers.map(({ issuer, clientId }) => ({ issuer, clientId })));

/** The key sets createApp takes in place of the remote `<issuer>/jwks` ones. */
export const keySetsOf = (...issuers: TestIssuer[]): Record<string, JWTVerifyGetKey> =>
  Object.fromEntries(issuers.map(({ issuer, keySet }) => [issuer, keySet]));
