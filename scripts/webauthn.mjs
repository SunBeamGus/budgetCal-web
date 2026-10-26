import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

export function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64url(value) {
  return Buffer.from(String(value), "base64url");
}

export function randomChallenge() {
  return base64url(randomBytes(32));
}

export function randomUserId() {
  return base64url(randomBytes(16));
}

export function parseCbor(data) {
  let offset = 0;

  function readLength(additional) {
    if (additional < 24) {
      return additional;
    }
    if (additional === 24) {
      const value = data[offset];
      offset += 1;
      return value;
    }
    if (additional === 25) {
      const value = data.readUInt16BE(offset);
      offset += 2;
      return value;
    }
    if (additional === 26) {
      const value = data.readUInt32BE(offset);
      offset += 4;
      return value;
    }
    if (additional === 27) {
      const value = data.readBigUInt64BE(offset);
      offset += 8;
      return Number(value);
    }
    throw new Error("Unsupported CBOR length.");
  }

  function parseValue() {
    const initial = data[offset];
    offset += 1;
    const majorType = initial >> 5;
    const additional = initial & 31;
    const length = majorType <= 5 ? readLength(additional) : 0;

    if (majorType === 0) {
      return length;
    }
    if (majorType === 1) {
      return -1 - length;
    }
    if (majorType === 2) {
      const value = data.subarray(offset, offset + length);
      offset += length;
      return value;
    }
    if (majorType === 3) {
      const value = data.subarray(offset, offset + length).toString("utf8");
      offset += length;
      return value;
    }
    if (majorType === 4) {
      return Array.from({ length }, parseValue);
    }
    if (majorType === 5) {
      const map = new Map();
      for (let index = 0; index < length; index += 1) {
        map.set(parseValue(), parseValue());
      }
      return map;
    }
    if (majorType === 7) {
      if (additional === 20) return false;
      if (additional === 21) return true;
      if (additional === 22) return null;
      if (additional === 23) return undefined;
    }
    throw new Error("Unsupported CBOR value.");
  }

  const value = parseValue();
  if (offset !== data.length) {
    throw new Error("Unexpected trailing CBOR data.");
  }
  return value;
}

function parseClientData(encoded, expectedType, expectedChallenge, expectedOrigin) {
  const clientData = JSON.parse(fromBase64url(encoded).toString("utf8"));
  if (clientData.type !== expectedType) {
    throw new Error("Unexpected WebAuthn ceremony type.");
  }
  if (clientData.challenge !== expectedChallenge) {
    throw new Error("WebAuthn challenge mismatch.");
  }
  if (clientData.origin !== expectedOrigin) {
    throw new Error("Unexpected WebAuthn origin.");
  }
  if (clientData.crossOrigin === true) {
    throw new Error("Cross-origin WebAuthn is not allowed.");
  }
  return clientData;
}

function verifyAuthData(authData, rpId) {
  if (authData.length < 37) {
    throw new Error("Authenticator data is too short.");
  }
  const expectedRpIdHash = createHash("sha256").update(rpId).digest();
  if (
    !timingSafeEqual(authData.subarray(0, 32), expectedRpIdHash) ||
    (authData[32] & 0x01) !== 0x01
  ) {
    throw new Error("Authenticator data does not match this app.");
  }
  const flags = authData[32];
  return {
    flags,
    counter: authData.readUInt32BE(33),
    userVerified: (flags & 0x04) === 0x04,
  };
}

function cosePublicKeyToJwk(coseKey) {
  if (!(coseKey instanceof Map)) {
    throw new Error("Credential public key is invalid.");
  }
  const keyType = coseKey.get(1);
  const algorithm = coseKey.get(3);
  if (keyType !== 2 || algorithm !== -7 || coseKey.get(-1) !== 1) {
    throw new Error("Only ES256 passkeys are supported.");
  }
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);
  if (!(x instanceof Buffer) || !(y instanceof Buffer)) {
    throw new Error("Credential public key coordinates are invalid.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: base64url(x),
    y: base64url(y),
  };
}

export function verifyRegistration({
  response,
  expectedChallenge,
  expectedOrigin,
  rpId,
}) {
  parseClientData(response.response.clientDataJSON, "webauthn.create", expectedChallenge, expectedOrigin);
  const attestationObject = fromBase64url(response.response.attestationObject);
  const decoded = parseCbor(attestationObject);
  const authData = decoded.get("authData");
  if (!(authData instanceof Buffer)) {
    throw new Error("Registration authenticator data is missing.");
  }
  const auth = verifyAuthData(authData, rpId);
  if (!auth.userVerified) {
    throw new Error("Passkey user verification is required.");
  }
  if ((auth.flags & 0x40) !== 0x40) {
    throw new Error("Registration did not include a credential public key.");
  }

  let offset = 37 + 16;
  const credentialIdLength = authData.readUInt16BE(offset);
  offset += 2;
  const credentialId = base64url(authData.subarray(offset, offset + credentialIdLength));
  offset += credentialIdLength;
  const coseKey = parseCbor(authData.subarray(offset));
  if (response.id !== credentialId) {
    throw new Error("Registered credential ID does not match.");
  }
  return {
    id: credentialId,
    publicKeyJwk: cosePublicKeyToJwk(coseKey),
    counter: auth.counter,
    transports: Array.isArray(response.response.transports)
      ? response.response.transports.filter((item) => typeof item === "string")
      : [],
  };
}

export function verifyAuthentication({
  response,
  storedCredential,
  expectedChallenge,
  expectedOrigin,
  rpId,
}) {
  parseClientData(response.response.clientDataJSON, "webauthn.get", expectedChallenge, expectedOrigin);
  if (response.id !== storedCredential.id) {
    throw new Error("Unknown passkey credential.");
  }
  const authData = fromBase64url(response.response.authenticatorData);
  const auth = verifyAuthData(authData, rpId);
  if (!auth.userVerified) {
    throw new Error("Passkey user verification is required.");
  }
  if (storedCredential.counter > 0 && auth.counter <= storedCredential.counter) {
    throw new Error("Passkey signature counter did not increase.");
  }

  const clientDataHash = createHash("sha256")
    .update(fromBase64url(response.response.clientDataJSON))
    .digest();
  const signedData = Buffer.concat([authData, clientDataHash]);
  const signature = fromBase64url(response.response.signature);
  const publicKey = createPublicKey({
    key: storedCredential.publicKeyJwk,
    format: "jwk",
  });
  if (!verify("sha256", signedData, publicKey, signature)) {
    throw new Error("Passkey signature verification failed.");
  }
  return { counter: auth.counter };
}
