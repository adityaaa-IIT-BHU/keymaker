import { createPublicKey, verify as cryptoVerify } from "node:crypto";

function b64urlJson(s) {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

/**
 * Verify an agent-platform attestation (ID-JAG-style JWT).
 * config.trusted_issuers: [{ issuer, jwks_url }] or [{ issuer, jwks: [<JWK>] }]
 * config.audience: optional expected aud
 * config.dev_accept_any_attestation: accept any non-empty token (local testing only)
 */
export async function verifyAttestation(token, config = {}) {
  const issuers = config.trusted_issuers ?? [];
  if (!issuers.length) {
    return config.dev_accept_any_attestation
      ? { verified: true, mode: "dev-accepted", claims: null }
      : { verified: false, reason: "no trusted_issuers configured (see signup.config.json)" };
  }

  let header, payload, signature, signingInput;
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) throw new Error("not a JWT");
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
    signature = Buffer.from(parts[2], "base64url");
    signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  } catch {
    return { verified: false, reason: "malformed attestation token" };
  }

  const issuer = issuers.find((i) => i.issuer === payload.iss);
  if (!issuer) return { verified: false, reason: `untrusted issuer: ${payload.iss}` };
  if (payload.exp && payload.exp * 1000 < Date.now()) {
    return { verified: false, reason: "attestation expired" };
  }
  if (config.audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(config.audience)) return { verified: false, reason: "audience mismatch" };
  }

  let jwks = issuer.jwks;
  if (!jwks && issuer.jwks_url) {
    try {
      const res = await fetch(issuer.jwks_url);
      if (!res.ok) return { verified: false, reason: `JWKS fetch failed: HTTP ${res.status}` };
      jwks = (await res.json()).keys;
    } catch (err) {
      return { verified: false, reason: `JWKS fetch failed: ${err.message}` };
    }
  }
  const jwk = (jwks ?? []).find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) return { verified: false, reason: "no matching key in JWKS" };

  let key;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return { verified: false, reason: "unusable JWK" };
  }

  let ok = false;
  if (header.alg === "RS256") ok = cryptoVerify("RSA-SHA256", signingInput, key, signature);
  else if (header.alg === "ES256")
    ok = cryptoVerify("SHA256", signingInput, { key, dsaEncoding: "ieee-p1363" }, signature);
  else if (header.alg === "EdDSA") ok = cryptoVerify(null, signingInput, key, signature);
  else return { verified: false, reason: `unsupported alg: ${header.alg}` };

  return ok
    ? { verified: true, mode: "jwt-verified", claims: payload }
    : { verified: false, reason: "bad signature" };
}
