import { createRemoteJWKSet, decodeJwt, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { TrustedIssuer } from "./config";

/** Who is calling: an Agent of one Workspace of one CoForge deployment. */
export type Caller = { issuer: string; workspaceId: string; agentId: string; scopes: Set<string> };

/**
 * Verifies the Agent access tokens CoForge issues for an app (RFC 9068 JWTs). Ship trusts several
 * CoForge deployments, each of which registers Ship as its own app with its own client ID, so the
 * verifier first reads the token's `iss` (without believing it) to pick the trusted entry, then
 * verifies fully against that issuer alone: ES256 signature against `<issuer>/jwks` by kid, typ
 * at+jwt, iss, aud = that issuer's client ID, exp, and type "agent". An issuer that is not listed
 * is refused. Scope enforcement is separate: see missingScopes.
 * `keySets` overrides the remote key set of an issuer (tests).
 */
export function createTokenVerifier(
  trusted: readonly TrustedIssuer[],
  keySets: Readonly<Record<string, JWTVerifyGetKey>> = {},
) {
  const entries = new Map(
    trusted.map(({ issuer, clientId }) => [
      issuer,
      {
        clientId,
        keys: Object.hasOwn(keySets, issuer)
          ? (keySets[issuer] as JWTVerifyGetKey)
          : createRemoteJWKSet(new URL(`${issuer}/jwks`)),
      },
    ]),
  );
  return async function verify(token: string): Promise<Caller> {
    const claimedIssuer = decodeJwt(token).iss;
    const entry = typeof claimedIssuer === "string" ? entries.get(claimedIssuer) : undefined;
    if (!entry) throw new errors.JWTClaimValidationFailed("issuer is not trusted", {}, "iss");
    const { payload } = await jwtVerify(token, entry.keys, {
      issuer: claimedIssuer as string,
      audience: entry.clientId,
      algorithms: ["ES256"],
      typ: "at+jwt",
      requiredClaims: ["sub", "exp", "scope"],
    });
    if (payload.type !== "agent") {
      throw new errors.JWTClaimValidationFailed('type must be "agent"', payload, "type");
    }
    if (typeof payload.workspace_id !== "string") {
      throw new errors.JWTClaimValidationFailed("workspace_id missing", payload, "workspace_id");
    }
    return {
      issuer: claimedIssuer as string,
      workspaceId: payload.workspace_id,
      agentId: payload.sub as string,
      scopes: new Set(String(payload.scope).split(/\s+/).filter(Boolean)),
    };
  };
}

/** Which of `required` the token lacks. `coforge app invoke` asks for a token of exactly the action's required_scopes. */
export const missingScopes = (granted: Set<string>, required: readonly string[]) =>
  required.filter((scope) => !granted.has(scope));
