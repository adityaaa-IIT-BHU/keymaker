import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { verifyAttestation } from "../src/attest.js";

function b64u(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function makeJwt({ priv, kid, iss, exp }) {
  const header = b64u({ alg: "ES256", typ: "JWT", kid });
  const payload = b64u({ iss, sub: "agent-1", exp });
  const data = Buffer.from(`${header}.${payload}`);
  const sig = sign("SHA256", data, { key: priv, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const ISS = "https://agents.example.com";
const config = { trusted_issuers: [{ issuer: ISS, jwks: [jwk] }] };
const future = Math.floor(Date.now() / 1000) + 300;

test("verifies a valid ES256 attestation", async () => {
  const out = await verifyAttestation(makeJwt({ priv: privateKey, kid: "k1", iss: ISS, exp: future }), config);
  assert.equal(out.verified, true);
  assert.equal(out.mode, "jwt-verified");
  assert.equal(out.claims.sub, "agent-1");
});

test("rejects untrusted issuer", async () => {
  const out = await verifyAttestation(
    makeJwt({ priv: privateKey, kid: "k1", iss: "https://evil.example.com", exp: future }),
    config
  );
  assert.equal(out.verified, false);
  assert.match(out.reason, /untrusted issuer/);
});

test("rejects expired attestation", async () => {
  const out = await verifyAttestation(
    makeJwt({ priv: privateKey, kid: "k1", iss: ISS, exp: Math.floor(Date.now() / 1000) - 10 }),
    config
  );
  assert.equal(out.verified, false);
  assert.match(out.reason, /expired/);
});

test("rejects tampered signature", async () => {
  const { privateKey: otherPriv } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const out = await verifyAttestation(makeJwt({ priv: otherPriv, kid: "k1", iss: ISS, exp: future }), config);
  assert.equal(out.verified, false);
  assert.equal(out.reason, "bad signature");
});

test("dev mode accepts anything only when explicitly flagged", async () => {
  assert.equal((await verifyAttestation("whatever", { dev_accept_any_attestation: true })).verified, true);
  assert.equal((await verifyAttestation("whatever", {})).verified, false);
});
