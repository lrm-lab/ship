import { createRemoteJWKSet, errors, jwtVerify } from "jose";

/**
 * Verifies the Agent access tokens CoForge issues for an app (RFC 9068 JWTs): ES256
 * signature against <issuer>/jwks by kid, typ at+jwt, iss, aud = this app's client ID,
 * exp, and type "agent". Scope enforcement is separate: see requireScopes.
 * @param {import("./config.js").Config} config
 * @param {import("jose").JWTVerifyGetKey} [keys] override for tests
 */
export function createTokenVerifier(config, keys = createRemoteJWKSet(new URL(`${config.issuer}/jwks`))) {
  return async function verify(token) {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ["ES256"],
      typ: "at+jwt",
      requiredClaims: ["sub", "exp", "scope"],
    });
    if (payload.type !== "agent") throw new errors.JWTClaimValidationFailed('type must be "agent"', payload, "type");
    if (typeof payload.workspace_id !== "string") {
      throw new errors.JWTClaimValidationFailed("workspace_id missing", payload, "workspace_id");
    }
    return {
      agentId: payload.sub,
      workspaceId: payload.workspace_id,
      scopes: new Set(String(payload.scope).split(/\s+/).filter(Boolean)),
    };
  };
}

/** Which of `required` the token lacks. `coforge app invoke` asks for a token of exactly the action's required_scopes. */
export const missingScopes = (granted, required) => required.filter((scope) => !granted.has(scope));
