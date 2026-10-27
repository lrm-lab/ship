import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Config } from "./config";

export type Caller = { agentId: string; workspaceId: string; scopes: Set<string> };

/**
 * Verifies the Agent access tokens CoForge issues for an app (RFC 9068 JWTs): ES256
 * signature against <issuer>/jwks by kid, typ at+jwt, iss, aud = this app's client ID,
 * exp, and type "agent". Scope enforcement is separate: see missingScopes.
 * `keys` overrides the remote key set (tests).
 */
export function createTokenVerifier(
  config: Pick<Config, "issuer" | "clientId">,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${config.issuer}/jwks`)),
) {
  return async function verify(token: string): Promise<Caller> {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ["ES256"],
      typ: "at+jwt",
      requiredClaims: ["sub", "exp", "scope"],
    });
    if (payload.type !== "agent")
      throw new errors.JWTClaimValidationFailed('type must be "agent"', payload, "type");
    if (typeof payload.workspace_id !== "string") {
      throw new errors.JWTClaimValidationFailed("workspace_id missing", payload, "workspace_id");
    }
    return {
      agentId: payload.sub as string,
      workspaceId: payload.workspace_id,
      scopes: new Set(String(payload.scope).split(/\s+/).filter(Boolean)),
    };
  };
}

/** Which of `required` the token lacks. `coforge app invoke` asks for a token of exactly the action's required_scopes. */
export const missingScopes = (granted: Set<string>, required: readonly string[]) =>
  required.filter((scope) => !granted.has(scope));
