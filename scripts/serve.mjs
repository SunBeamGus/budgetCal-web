import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EncryptedHostStore } from "./host-store.mjs";
import {
  randomChallenge,
  randomUserId,
  verifyAuthentication,
  verifyRegistration,
} from "./webauthn.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const storageMode = ["host", "mysql"].includes(process.env.STORAGE_MODE)
  ? process.env.STORAGE_MODE
  : "browser";
const dataDirectory = resolve(
  process.env.BUDGET_CAL_DATA_DIR || join(root, "host-data"),
);
const authFile = join(dataDirectory, "budget-cal.auth.json");
const mysqlDatabaseUrl = process.env.BUDGET_CAL_DATABASE_URL || "";
const mysqlMasterKeyFile =
  process.env.BUDGET_CAL_MASTER_KEY_FILE || join(dataDirectory, "master.key");
const maxBodyBytes = 10 * 1024 * 1024;
const publicOrigin = String(
  process.env.BUDGET_CAL_PUBLIC_ORIGIN || `http://localhost:${port}`,
).replace(/\/+$/, "");
let publicOriginUrl;
try {
  publicOriginUrl = new URL(publicOrigin);
} catch {
  throw new Error("BUDGET_CAL_PUBLIC_ORIGIN must be a valid absolute URL.");
}
if (!["http:", "https:"].includes(publicOriginUrl.protocol)) {
  throw new Error("BUDGET_CAL_PUBLIC_ORIGIN must use http or https.");
}
const rpId = process.env.BUDGET_CAL_RP_ID || publicOriginUrl.hostname;
const secureCookies =
  publicOriginUrl.protocol === "https:" ||
  process.env.BUDGET_CAL_COOKIE_SECURE === "true";
const registrationToken = process.env.BUDGET_CAL_REGISTRATION_TOKEN || "";
const trustReverseProxy = process.env.BUDGET_CAL_TRUST_REVERSE_PROXY === "true";
const configuredAllowedOrigins = String(
  process.env.BUDGET_CAL_ALLOWED_ORIGINS || "",
)
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const rpName = "Budget Cal";
const sessionDurationMs = 12 * 60 * 60 * 1000;

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function loadAuthData() {
  if (!(await fileExists(authFile))) {
    return { userId: null, credential: null };
  }
  const data = JSON.parse(await readFile(authFile, "utf8"));
  if (!data || typeof data !== "object") {
    throw new Error("The passkey metadata file is invalid.");
  }
  return {
    userId: data.userId || null,
    credential:
      data.credential && data.credential.id && data.credential.publicKeyJwk
        ? data.credential
        : null,
  };
}

async function saveAuthData(data) {
  const temporaryFile = `${authFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await chmod(temporaryFile, 0o600);
  } catch {
    // Windows does not apply POSIX file modes.
  }
  await rename(temporaryFile, authFile);
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    const error = new Error("Request body is required.");
    error.statusCode = 400;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function parseCookies(request) {
  const cookies = {};
  for (const part of String(request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      cookies[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
  }
  return cookies;
}

function allowedOrigin(request) {
  const forwardedProtocol = String(
    request.headers["x-forwarded-proto"] || publicOriginUrl.protocol.replace(":", ""),
  )
    .split(",")[0]
    .trim();
  const fallbackOrigin = `${forwardedProtocol}://${request.headers.host || publicOriginUrl.host}`;
  const origin =
    request.headers.origin ||
    fallbackOrigin;
  const allowed = new Set([publicOrigin, ...configuredAllowedOrigins]);
  if (publicOriginUrl.hostname === "localhost") {
    allowed.add(`http://127.0.0.1:${port}`);
  }
  if (!allowed.has(origin)) {
    console.warn(
      `Rejected request origin: ${origin} (fallback ${fallbackOrigin}, host ${request.headers.host || "unknown"})`,
    );
    const error = new Error("Unexpected request origin.");
    error.statusCode = 403;
    throw error;
  }
  return publicOrigin;
}

const sessions = new Map();
const registrationChallenges = new Map();
const authenticationChallenges = new Map();

function sessionToken(request) {
  return parseCookies(request)["budget-cal-session"] || "";
}

function isAuthenticated(request) {
  const token = sessionToken(request);
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  return true;
}

function getSession(request) {
  const token = sessionToken(request);
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function issueSession(response, userId = null) {
  const token = randomBytes(32).toString("base64url");
  sessions.set(token, { expiresAt: Date.now() + sessionDurationMs, userId });
  return `budget-cal-session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookies ? "; Secure" : ""}`;
}

function clearSessionCookie() {
  return `budget-cal-session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? "; Secure" : ""}`;
}

function consumeChallenge(store, request) {
  const origin = allowedOrigin(request);
  const challenge = store.get(origin);
  store.delete(origin);
  if (!challenge || challenge.expiresAt <= Date.now()) {
    const error = new Error("The passkey challenge has expired. Try again.");
    error.statusCode = 400;
    throw error;
  }
  return challenge;
}

async function requireHostSession(request, response) {
  if (!isAuthenticated(request)) {
    sendJson(response, 401, { error: "Passkey authentication required." });
    return false;
  }
  return true;
}

let hostStore = null;
let authData = { userId: null, credential: null };
let mysqlStore = null;

async function initializeHostMode() {
  if (storageMode !== "host") {
    return;
  }
  if (
    host !== "127.0.0.1" &&
    host !== "::1" &&
    host !== "localhost" &&
    !trustReverseProxy
  ) {
    throw new Error("Encrypted host mode must bind only to the local machine.");
  }
  hostStore = new EncryptedHostStore(dataDirectory);
  await hostStore.initialize();
  authData = await loadAuthData();
}

async function initializeMysqlMode() {
  if (storageMode !== "mysql") {
    return;
  }
  if (!mysqlDatabaseUrl) {
    throw new Error("BUDGET_CAL_DATABASE_URL is required in MySQL mode.");
  }
  const { MysqlStore } = await import("./mysql-store.mjs");
  mysqlStore = new MysqlStore(mysqlDatabaseUrl, mysqlMasterKeyFile);
  await mysqlStore.initialize();
}

async function handleAuthApi(request, response, pathname) {
  if (!pathname.startsWith("/api/auth/")) {
    return false;
  }
  if (storageMode !== "host") {
    sendJson(response, 404, { error: "Passkey authentication is only available in host mode." });
    return true;
  }

  if (pathname === "/api/auth/status" && request.method === "GET") {
    sendJson(response, 200, {
      registered: Boolean(authData.credential),
      authenticated: isAuthenticated(request),
      registrationRequiresToken: Boolean(registrationToken),
    });
    return true;
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const token = sessionToken(request);
    if (token) sessions.delete(token);
    sendJson(
      response,
      200,
      { authenticated: false },
      { "Set-Cookie": clearSessionCookie() },
    );
    return true;
  }

  if (pathname === "/api/auth/register/options" && request.method === "POST") {
    if (authData.credential) {
      sendJson(response, 409, { error: "A passkey is already registered." });
      return true;
    }
    if (registrationToken) {
      const providedToken = String(
        request.headers["x-budget-cal-registration-token"] || "",
      );
      const expectedBuffer = Buffer.from(registrationToken);
      const providedBuffer = Buffer.from(providedToken);
      if (
        expectedBuffer.length !== providedBuffer.length ||
        !timingSafeEqual(expectedBuffer, providedBuffer)
      ) {
        sendJson(response, 403, {
          error: "A valid one-time registration token is required.",
        });
        return true;
      }
    }
    const origin = allowedOrigin(request);
    const challenge = randomChallenge();
    const userId = authData.userId || randomUserId();
    registrationChallenges.set(origin, {
      challenge,
      userId,
      expiresAt: Date.now() + 120000,
    });
    sendJson(response, 200, {
      challenge,
      rp: { id: rpId, name: rpName },
      user: { id: userId, name: "local-user", displayName: "Budget Cal" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 120000,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: [],
    });
    return true;
  }

  if (pathname === "/api/auth/register/verify" && request.method === "POST") {
    try {
      if (registrationToken) {
        const providedToken = String(
          request.headers["x-budget-cal-registration-token"] || "",
        );
        const expectedBuffer = Buffer.from(registrationToken);
        const providedBuffer = Buffer.from(providedToken);
        if (
          expectedBuffer.length !== providedBuffer.length ||
          !timingSafeEqual(expectedBuffer, providedBuffer)
        ) {
          sendJson(response, 403, {
            error: "A valid one-time registration token is required.",
          });
          return true;
        }
      }
      const pending = consumeChallenge(registrationChallenges, request);
      const payload = await readJsonBody(request);
      const credential = verifyRegistration({
        response: payload.credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: allowedOrigin(request),
        rpId,
      });
      authData = {
        userId: pending.userId,
        credential: {
          ...credential,
          createdAt: new Date().toISOString(),
        },
      };
      await saveAuthData(authData);
      sendJson(
        response,
        200,
        { registered: true, authenticated: true },
        { "Set-Cookie": issueSession(response) },
      );
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === "/api/auth/login/options" && request.method === "POST") {
    if (!authData.credential) {
      sendJson(response, 409, { error: "Create a passkey before signing in." });
      return true;
    }
    const origin = allowedOrigin(request);
    const challenge = randomChallenge();
    authenticationChallenges.set(origin, {
      challenge,
      expiresAt: Date.now() + 120000,
    });
    sendJson(response, 200, {
      challenge,
      rpId,
      timeout: 120000,
      userVerification: "required",
      allowCredentials: [
        {
          type: "public-key",
          id: authData.credential.id,
          transports: authData.credential.transports || [],
        },
      ],
    });
    return true;
  }

  if (pathname === "/api/auth/login/verify" && request.method === "POST") {
    try {
      const pending = consumeChallenge(authenticationChallenges, request);
      const payload = await readJsonBody(request);
      const result = verifyAuthentication({
        response: payload.credential,
        storedCredential: authData.credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: allowedOrigin(request),
        rpId,
      });
      authData.credential.counter = result.counter;
      await saveAuthData(authData);
      sendJson(
        response,
        200,
        { authenticated: true },
        { "Set-Cookie": issueSession(response) },
      );
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  sendJson(response, 404, { error: "Authentication endpoint not found." });
  return true;
}

const mysqlRegistrationChallenges = new Map();
const mysqlAuthenticationChallenges = new Map();
const mysqlPasskeyChallenges = new Map();

function hashInvitationToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(expected, provided) {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function validInvitationHours(value) {
  const hours = Number(value ?? 168);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    const error = new Error("Invitation expiry must be between 1 and 720 hours.");
    error.statusCode = 400;
    throw error;
  }
  return hours;
}

function challengeFromCredential(credential) {
  try {
    return JSON.parse(
      Buffer.from(credential.response.clientDataJSON, "base64url").toString("utf8"),
    ).challenge;
  } catch {
    return "";
  }
}

async function mysqlSessionContext(request) {
  const session = getSession(request);
  if (!session?.userId) {
    return null;
  }
  const user = await mysqlStore.getUserById(session.userId);
  const memberships = await mysqlStore.getMemberships(session.userId);
  if (!user || user.isDisabled) {
    return null;
  }
  return { session, user, memberships };
}

async function mysqlAdminContext(request) {
  const context = await mysqlSessionContext(request);
  if (!context) {
    return { error: "Authentication required.", status: 401 };
  }
  if (!context.user.isAdmin) {
    return { error: "Administrator access required.", status: 403 };
  }
  return { context };
}

async function mysqlOwnerContext(request, workspaceId) {
  const context = await mysqlSessionContext(request);
  if (!context) return { error: "Authentication required.", status: 401 };
  const membership = context.memberships.find(
    (item) => item.workspaceId === workspaceId,
  );
  if (!membership) {
    return { error: "You do not have access to this workspace.", status: 403 };
  }
  if (membership.role !== "owner") {
    return { error: "Only the workspace owner can manage members.", status: 403 };
  }
  return { context, membership };
}

async function handleMysqlAuthApi(request, response, pathname) {
  if (!pathname.startsWith("/api/auth/")) {
    return false;
  }

  if (pathname === "/api/auth/status" && request.method === "GET") {
    const hasUsers = await mysqlStore.hasUsers();
    const context = await mysqlSessionContext(request);
    sendJson(response, 200, {
      registered: hasUsers,
      authenticated: Boolean(context),
      registrationMode: hasUsers ? "invite" : "bootstrap",
      registrationRequiresToken: !hasUsers && Boolean(registrationToken),
      user: context
        ? {
            id: context.user.id,
            username: context.user.username,
            displayName: context.user.displayName,
            isAdmin: Boolean(context.user.isAdmin),
          }
        : null,
      workspaces: context?.memberships || [],
    });
    return true;
  }

  if (pathname === "/api/auth/logout" && request.method === "POST") {
    const session = getSession(request);
    if (session) sessions.delete(session.token);
    sendJson(
      response,
      200,
      { authenticated: false },
      { "Set-Cookie": clearSessionCookie() },
    );
    return true;
  }

  if (pathname === "/api/auth/register/options" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const username = String(body.username || "").trim().toLowerCase();
      const displayName = String(body.displayName || "").trim();
      if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
        throw new Error("Username must contain 3-40 letters, numbers, dots, dashes, or underscores.");
      }
      if (!displayName || displayName.length > 80) {
        throw new Error("Enter a display name of up to 80 characters.");
      }

      const hasUsers = await mysqlStore.hasUsers();
      let invitation = null;
      if (!hasUsers) {
        const providedToken = String(
          request.headers["x-budget-cal-registration-token"] || body.registrationToken || "",
        );
        if (registrationToken && !tokenMatches(registrationToken, providedToken)) {
          throw new Error("A valid first-owner registration token is required.");
        }
      } else {
        const inviteToken = String(body.inviteToken || "").trim();
        if (!inviteToken) {
          throw new Error("An invitation code is required.");
        }
        invitation = await mysqlStore.getInvitation(hashInvitationToken(inviteToken));
        if (
          !invitation ||
          invitation.usedAt ||
          new Date(invitation.expiresAt) <= new Date()
        ) {
          throw new Error("This invitation is invalid or has expired.");
        }
      }

      const origin = allowedOrigin(request);
      const challenge = randomChallenge();
      const userId = randomUUID();
      mysqlRegistrationChallenges.set(challenge, {
        challenge,
        userId,
        username,
        displayName,
        invitation,
        origin,
        expiresAt: Date.now() + 120000,
      });
      sendJson(response, 200, {
        challenge,
        rp: { id: rpId, name: rpName },
        user: {
          id: Buffer.from(userId).toString("base64url"),
          name: username,
          displayName,
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 120000,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        excludeCredentials: [],
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (pathname === "/api/auth/register/verify" && request.method === "POST") {
    try {
      const payload = await readJsonBody(request);
      const challenge = challengeFromCredential(payload.credential);
      const pending = mysqlRegistrationChallenges.get(challenge);
      mysqlRegistrationChallenges.delete(challenge);
      if (!pending || pending.expiresAt <= Date.now()) {
        throw new Error("The registration challenge has expired.");
      }
      const credential = verifyRegistration({
        response: payload.credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        rpId,
      });
      const user = {
        id: pending.userId,
        username: pending.username,
        displayName: pending.displayName,
      };
      if (pending.invitation) {
        await mysqlStore.createInvitedAccount({
          user,
          credential,
          invitationId: pending.invitation.id,
        });
      } else {
        await mysqlStore.createInitialAccount({ user, credential });
      }
      sendJson(
        response,
        200,
        { registered: true, authenticated: true },
        { "Set-Cookie": issueSession(response, user.id) },
      );
    } catch (error) {
      const message =
        error.code === "ER_DUP_ENTRY"
          ? "That username is already in use."
          : error.message;
      sendJson(response, 400, { error: message });
    }
    return true;
  }

  if (pathname === "/api/auth/login/options" && request.method === "POST") {
    try {
      const challenge = randomChallenge();
      const origin = allowedOrigin(request);
      mysqlAuthenticationChallenges.set(challenge, {
        challenge,
        origin,
        expiresAt: Date.now() + 120000,
      });
      sendJson(response, 200, {
        challenge,
        rpId,
        timeout: 120000,
        userVerification: "required",
      });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (pathname === "/api/auth/login/verify" && request.method === "POST") {
    try {
      const payload = await readJsonBody(request);
      const challenge = challengeFromCredential(payload.credential);
      const pending = mysqlAuthenticationChallenges.get(challenge);
      mysqlAuthenticationChallenges.delete(challenge);
      if (!pending || pending.expiresAt <= Date.now()) {
        throw new Error("The login challenge has expired.");
      }
      const storedCredential = await mysqlStore.getCredentialById(
        payload.credential.id,
      );
      if (!storedCredential) {
        throw new Error("This passkey is not registered.");
      }
      const user = await mysqlStore.getUserById(storedCredential.userId);
      if (!user || user.isDisabled) {
        throw new Error("This account is unavailable.");
      }
      const result = verifyAuthentication({
        response: payload.credential,
        storedCredential,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        rpId,
      });
      await mysqlStore.updateCredentialCounter(storedCredential.id, result.counter);
      sendJson(
        response,
        200,
        { authenticated: true },
        { "Set-Cookie": issueSession(response, storedCredential.userId) },
      );
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (pathname === "/api/auth/passkeys" && request.method === "GET") {
    try {
      const context = await mysqlSessionContext(request);
      if (!context) {
        sendJson(response, 401, { error: "Authentication required." });
        return true;
      }
      sendJson(response, 200, {
        passkeys: await mysqlStore.listPasskeys(context.user.id),
      });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return true;
  }

  if (pathname === "/api/auth/passkeys/options" && request.method === "POST") {
    try {
      const context = await mysqlSessionContext(request);
      if (!context) {
        sendJson(response, 401, { error: "Authentication required." });
        return true;
      }
      const body = await readJsonBody(request);
      const label = String(body.label || "Passkey").trim().slice(0, 80);
      const credentials = await mysqlStore.getCredentialsForUser(context.user.id);
      if (credentials.length >= 10) {
        sendJson(response, 400, { error: "An account can have at most 10 passkeys." });
        return true;
      }
      const challenge = randomChallenge();
      const origin = allowedOrigin(request);
      mysqlPasskeyChallenges.set(challenge, {
        challenge,
        userId: context.user.id,
        origin,
        label: label || "Passkey",
        expiresAt: Date.now() + 120000,
      });
      sendJson(response, 200, {
        challenge,
        rp: { id: rpId, name: rpName },
        user: {
          id: Buffer.from(context.user.id).toString("base64url"),
          name: context.user.username,
          displayName: context.user.displayName,
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        timeout: 120000,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        excludeCredentials: credentials.map((credential) => ({
          type: "public-key",
          id: credential.id,
          transports: credential.transports || [],
        })),
      });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
    }
    return true;
  }

  if (pathname === "/api/auth/passkeys/verify" && request.method === "POST") {
    try {
      const context = await mysqlSessionContext(request);
      if (!context) {
        sendJson(response, 401, { error: "Authentication required." });
        return true;
      }
      const payload = await readJsonBody(request);
      const challenge = challengeFromCredential(payload.credential);
      const pending = mysqlPasskeyChallenges.get(challenge);
      mysqlPasskeyChallenges.delete(challenge);
      if (
        !pending ||
        pending.expiresAt <= Date.now() ||
        pending.userId !== context.user.id
      ) {
        throw new Error("The passkey registration challenge has expired.");
      }
      const credential = verifyRegistration({
        response: payload.credential,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        rpId,
      });
      await mysqlStore.addPasskey(context.user.id, {
        ...credential,
        label: pending.label,
      });
      sendJson(response, 201, { added: true });
    } catch (error) {
      const message =
        error.code === "ER_DUP_ENTRY"
          ? "That passkey is already registered."
          : error.message;
      sendJson(response, 400, { error: message });
    }
    return true;
  }

  if (pathname.startsWith("/api/auth/passkeys/") && request.method === "DELETE") {
    try {
      const context = await mysqlSessionContext(request);
      if (!context) {
        sendJson(response, 401, { error: "Authentication required." });
        return true;
      }
      const credentialId = decodeURIComponent(
        pathname.slice("/api/auth/passkeys/".length),
      );
      await mysqlStore.deletePasskey(context.user.id, credentialId);
      sendJson(response, 200, { deleted: true });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  sendJson(response, 404, { error: "Authentication endpoint not found." });
  return true;
}

async function handleApi(request, response, pathname) {
  if (pathname === "/api/config" && request.method === "GET") {
    sendJson(response, 200, {
      app: "Budget Cal",
      storage: storageMode,
      publicOrigin,
    });
    return true;
  }

  if (
    storageMode === "mysql" &&
    (await handleMysqlAuthApi(request, response, pathname))
  ) {
    return true;
  }

  if (await handleAuthApi(request, response, pathname)) {
    return true;
  }

  if (storageMode === "mysql" && pathname.startsWith("/api/admin/")) {
    try {
      const access = await mysqlAdminContext(request);
      if (access.error) {
        sendJson(response, access.status, { error: access.error });
        return true;
      }
      const adminId = access.context.user.id;

      if (pathname === "/api/admin/users" && request.method === "GET") {
        sendJson(response, 200, { users: await mysqlStore.listAllUsers() });
        return true;
      }
      const userMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userMatch && request.method === "PATCH") {
        const userId = decodeURIComponent(userMatch[1]);
        const body = await readJsonBody(request);
        await mysqlStore.setUserDisabled(adminId, userId, Boolean(body.disabled));
        sendJson(response, 200, { updated: true });
        return true;
      }
      if (pathname === "/api/admin/workspaces" && request.method === "GET") {
        sendJson(response, 200, { workspaces: await mysqlStore.listAllWorkspaces() });
        return true;
      }
      if (pathname === "/api/admin/workspaces" && request.method === "POST") {
        const body = await readJsonBody(request);
        const name = String(body.name || "").trim();
        if (!name || name.length > 80) {
          sendJson(response, 400, { error: "Workspace name must contain 1-80 characters." });
          return true;
        }
        sendJson(
          response,
          201,
          await mysqlStore.createWorkspace(adminId, name, false),
        );
        return true;
      }
      const workspaceMatch = pathname.match(
        /^\/api\/admin\/workspaces\/([^/]+)$/,
      );
      if (workspaceMatch && request.method === "DELETE") {
        await mysqlStore.deleteWorkspace(
          decodeURIComponent(workspaceMatch[1]),
        );
        sendJson(response, 200, { deleted: true });
        return true;
      }
      if (pathname === "/api/admin/invitations" && request.method === "GET") {
        sendJson(response, 200, {
          invitations: await mysqlStore.listAllInvitations(),
        });
        return true;
      }
      if (pathname === "/api/admin/invitations" && request.method === "POST") {
        const body = await readJsonBody(request);
        const workspaceId = String(body.workspaceId || "");
        const role = body.role === "viewer" ? "viewer" : "editor";
        const expirationHours = validInvitationHours(body.expirationHours);
        const workspaces = await mysqlStore.listAllWorkspaces();
        if (!workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
          sendJson(response, 404, { error: "Workspace not found." });
          return true;
        }
        const inviteToken = randomBytes(32).toString("base64url");
        await mysqlStore.createInvitation({
          workspaceId,
          tokenHash: hashInvitationToken(inviteToken),
          role,
          createdBy: adminId,
          expiresAt: new Date(Date.now() + expirationHours * 60 * 60 * 1000),
        });
        sendJson(response, 200, {
          role,
          expirationHours,
          url: `${publicOrigin}/?invite=${encodeURIComponent(inviteToken)}`,
        });
        return true;
      }

      const invitationMatch = pathname.match(
        /^\/api\/admin\/invitations\/([^/]+)$/,
      );
      if (invitationMatch && request.method === "DELETE") {
        const invitationId = decodeURIComponent(invitationMatch[1]);
        const invitations = await mysqlStore.listAllInvitations();
        const invitation = invitations.find((item) => item.id === invitationId);
        if (!invitation) {
          sendJson(response, 404, { error: "Invitation not found." });
          return true;
        }
        await mysqlStore.revokeInvitation(invitation.workspaceId, invitationId);
        sendJson(response, 200, { revoked: true });
        return true;
      }

      const membersMatch = pathname.match(
        /^\/api\/admin\/workspaces\/([^/]+)\/members$/,
      );
      if (membersMatch && request.method === "GET") {
        const workspaceId = decodeURIComponent(membersMatch[1]);
        sendJson(response, 200, {
          members: await mysqlStore.listWorkspaceMembers(workspaceId),
        });
        return true;
      }

      const memberMatch = pathname.match(
        /^\/api\/admin\/workspaces\/([^/]+)\/members\/([^/]+)$/,
      );
      if (memberMatch) {
        const workspaceId = decodeURIComponent(memberMatch[1]);
        const userId = decodeURIComponent(memberMatch[2]);
        if (request.method === "PATCH") {
          const body = await readJsonBody(request);
          await mysqlStore.updateMemberRole(workspaceId, userId, String(body.role || ""));
          sendJson(response, 200, { updated: true });
          return true;
        }
        if (request.method === "DELETE") {
          await mysqlStore.removeWorkspaceMember(workspaceId, userId);
          sendJson(response, 200, { removed: true });
          return true;
        }
      }

      sendJson(response, 404, { error: "Admin endpoint not found." });
    } catch (error) {
      sendJson(response, error.statusCode || 400, {
        error: error.message || "Administrator operation failed.",
      });
    }
    return true;
  }

  if (
    storageMode === "mysql" &&
    pathname === "/api/workspace/members" &&
    request.method === "GET"
  ) {
    try {
      const workspaceId = String(request.headers["x-budget-cal-workspace"] || "");
      const access = await mysqlOwnerContext(request, workspaceId);
      if (access.error) {
        sendJson(response, access.status, { error: access.error });
        return true;
      }
      sendJson(response, 200, {
        members: await mysqlStore.listWorkspaceMembers(workspaceId),
      });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return true;
  }

  if (
    storageMode === "mysql" &&
    pathname.startsWith("/api/workspace/members/")
  ) {
    try {
      const workspaceId = String(request.headers["x-budget-cal-workspace"] || "");
      const access = await mysqlOwnerContext(request, workspaceId);
      if (access.error) {
        sendJson(response, access.status, { error: access.error });
        return true;
      }
      const userId = decodeURIComponent(
        pathname.slice("/api/workspace/members/".length),
      );
      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        await mysqlStore.updateMemberRole(
          workspaceId,
          userId,
          String(body.role || ""),
        );
        sendJson(response, 200, { updated: true });
        return true;
      }
      if (request.method === "DELETE") {
        await mysqlStore.removeWorkspaceMember(workspaceId, userId);
        sendJson(response, 200, { removed: true });
        return true;
      }
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return true;
    }
  }

  if (
    storageMode === "mysql" &&
    pathname === "/api/workspace/invitations" &&
    request.method === "GET"
  ) {
    try {
      const workspaceId = String(request.headers["x-budget-cal-workspace"] || "");
      const access = await mysqlOwnerContext(request, workspaceId);
      if (access.error) {
        sendJson(response, access.status, { error: access.error });
        return true;
      }
      sendJson(response, 200, {
        invitations: await mysqlStore.listWorkspaceInvitations(workspaceId),
      });
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return true;
  }

  if (
    storageMode === "mysql" &&
    pathname.startsWith("/api/workspace/invitations/") &&
    request.method === "DELETE"
  ) {
    try {
      const workspaceId = String(request.headers["x-budget-cal-workspace"] || "");
      const access = await mysqlOwnerContext(request, workspaceId);
      if (access.error) {
        sendJson(response, access.status, { error: access.error });
        return true;
      }
      const invitationId = decodeURIComponent(
        pathname.slice("/api/workspace/invitations/".length),
      );
      await mysqlStore.revokeInvitation(workspaceId, invitationId);
      sendJson(response, 200, { revoked: true });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }

  if (
    storageMode === "mysql" &&
    pathname === "/api/workspaces" &&
    ["GET", "POST"].includes(request.method)
  ) {
    try {
      const context = await mysqlSessionContext(request);
      if (!context) {
        sendJson(response, 401, { error: "Authentication required." });
        return true;
      }
      if (request.method === "GET") {
        sendJson(response, 200, { workspaces: context.memberships });
        return true;
      }
      if (!context.user.isAdmin) {
        sendJson(response, 403, {
          error: "Only the system administrator can create workspaces.",
        });
        return true;
      }
      const body = await readJsonBody(request);
      const name = String(body.name || "").trim();
      if (!name || name.length > 80) {
        sendJson(response, 400, { error: "Workspace name must contain 1-80 characters." });
        return true;
      }
      const workspace = await mysqlStore.createWorkspace(context.user.id, name);
      sendJson(response, 201, workspace);
    } catch (error) {
      sendJson(response, error.statusCode || 400, {
        error: error.message || "Could not create the workspace.",
      });
    }
    return true;
  }

  if (
    storageMode === "mysql" &&
    pathname === "/api/workspace/join" &&
    request.method === "POST"
  ) {
    try {
      const context = await mysqlSessionContext(request);
      if (!context) {
        sendJson(response, 401, { error: "Authentication required." });
        return true;
      }
      const body = await readJsonBody(request);
      const invitation = await mysqlStore.getInvitation(
        hashInvitationToken(String(body.inviteToken || "")),
      );
      if (!invitation) {
        sendJson(response, 400, { error: "Invalid or expired invitation." });
        return true;
      }
      const membership = await mysqlStore.joinWorkspace(
        context.user.id,
        invitation.id,
      );
      sendJson(response, 200, membership);
    } catch (error) {
      sendJson(response, error.statusCode || 400, {
        error: error.message || "Could not join the workspace.",
      });
    }
    return true;
  }

  if (
    storageMode === "mysql" &&
    pathname === "/api/workspace/invitations" &&
    request.method === "POST"
  ) {
    try {
      const context = await mysqlSessionContext(request);
      if (!context) {
        sendJson(response, 401, { error: "Authentication required." });
        return true;
      }
      const body = await readJsonBody(request);
      const membership = context.memberships.find(
        (item) => item.workspaceId === body.workspaceId,
      );
      if (!membership || membership.role !== "owner") {
        sendJson(response, 403, { error: "Only the workspace owner can invite members." });
        return true;
      }
      const role = body.role === "viewer" ? "viewer" : "editor";
      const expirationHours = validInvitationHours(body.expirationHours);
      const token = randomBytes(32).toString("base64url");
      await mysqlStore.createInvitation({
        workspaceId: membership.workspaceId,
        tokenHash: hashInvitationToken(token),
        role,
        createdBy: context.user.id,
        expiresAt: new Date(Date.now() + expirationHours * 60 * 60 * 1000),
      });
      sendJson(response, 200, {
        token,
        role,
        expirationHours,
        url: `${publicOrigin}/?invite=${encodeURIComponent(token)}`,
      });
    } catch (error) {
      sendJson(response, error.statusCode || 400, {
        error: error.message || "Could not create an invitation.",
      });
    }
    return true;
  }

  if (storageMode === "mysql" && pathname === "/api/state") {
    try {
      const context = await mysqlSessionContext(request);
      if (!context) {
        sendJson(response, 401, { error: "Passkey authentication required." });
        return true;
      }
      const requestedWorkspace =
        String(request.headers["x-budget-cal-workspace"] || "") ||
        context.memberships[0].workspaceId;
      const membership = context.memberships.find(
        (item) => item.workspaceId === requestedWorkspace,
      );
      if (!membership) {
        sendJson(response, 403, { error: "You do not have access to this workspace." });
        return true;
      }
      if (request.method === "GET") {
        const state = await mysqlStore.getWorkspaceState(membership.workspaceId);
        sendJson(response, 200, state);
        return true;
      }
      if (request.method === "PUT") {
        if (membership.role === "viewer") {
          sendJson(response, 403, { error: "Viewer access is read-only." });
          return true;
        }
        if (request.headers["x-budget-cal-request"] !== "save") {
          sendJson(response, 403, { error: "Missing save request header." });
          return true;
        }
        const nextState = await readJsonBody(request);
        if (!nextState || typeof nextState !== "object" || Array.isArray(nextState)) {
          sendJson(response, 400, { error: "State must be a JSON object." });
          return true;
        }
        await mysqlStore.saveWorkspaceState(membership.workspaceId, nextState);
        sendJson(response, 200, { saved: true });
        return true;
      }
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: error.message || "Could not access workspace data.",
      });
      return true;
    }
  }

  if (pathname === "/api/state" && storageMode === "host") {
    if (!(await requireHostSession(request, response))) {
      return true;
    }
    if (request.method === "GET") {
      sendJson(response, 200, hostStore.state);
      return true;
    }
    if (request.method === "PUT") {
      if (request.headers["x-budget-cal-request"] !== "save") {
        sendJson(response, 403, { error: "Missing save request header." });
        return true;
      }
      try {
        const nextState = await readJsonBody(request);
        if (!nextState || typeof nextState !== "object" || Array.isArray(nextState)) {
          sendJson(response, 400, { error: "State must be a JSON object." });
          return true;
        }
        await hostStore.save(nextState);
        sendJson(response, 200, { saved: true });
      } catch (error) {
        sendJson(response, error.statusCode || 500, {
          error: error.message || "Could not save host data.",
        });
      }
      return true;
    }
  }

  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "API endpoint not found." });
    return true;
  }
  return false;
}

function isBlockedStaticPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.includes("host-data") ||
    segments.some((segment) => segment === ".git" || segment.startsWith(".env"))
  );
}

await initializeHostMode();
await initializeMysqlMode();

const server = createServer(async (request, response) => {
  const requestUrl = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`,
  );
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === "/admin") {
    response.writeHead(308, {
      Location: `/admin/${requestUrl.search}`,
      "Cache-Control": "no-store",
    });
    response.end();
    return;
  }

  if (await handleApi(request, response, pathname)) {
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }
  const relativePath =
    pathname === "/"
      ? "index.html"
      : pathname.endsWith("/")
        ? `${pathname.replace(/^\/+/, "")}index.html`
        : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(root, relativePath));
  if (
    !filePath.startsWith(root) ||
    isBlockedStaticPath(pathname) ||
    !(await fileExists(filePath))
  ) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-cache",
    "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Service-Worker-Allowed": "/",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Budget Cal is running at http://localhost:${port}`);
  console.log(`Public origin: ${publicOrigin}`);
  console.log(
    storageMode === "host"
      ? "Storage mode: encrypted host data, protected by a passkey."
      : storageMode === "mysql"
        ? "Storage mode: shared MySQL workspaces, protected by passkeys."
      : "Storage mode: browser IndexedDB.",
  );
  if (host === "0.0.0.0" || host === "::") {
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter((address) => address && !address.internal && address.family === "IPv4")
      .map((address) => `http://${address.address}:${port}`);
    for (const address of addresses) {
      console.log(`Network access: ${address}`);
    }
    console.log("LAN mode is active. Use only on a trusted network.");
    console.log("Budget data is stored separately in each browser.");
  }
  if (storageMode === "host" && !authData.credential) {
    console.log("Create a passkey in the browser to initialize host storage.");
  }
  console.log("Press Ctrl+C to stop.");
});
