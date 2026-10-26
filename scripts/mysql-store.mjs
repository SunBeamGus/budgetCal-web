import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import mysql from "mysql2/promise";

const encryptionFormat = "budget-cal-workspace";

function emptyState() {
  return {
    settings: null,
    categories: [],
    allocations: [],
    transactions: [],
    assets: [],
    groupBudgets: [],
  };
}

export class MysqlStore {
  constructor(databaseUrl, masterKeyFile) {
    this.databaseUrl = databaseUrl;
    this.masterKeyFile = masterKeyFile;
    this.pool = null;
    this.masterKey = null;
  }

  async initialize() {
    await mkdir(dirname(this.masterKeyFile), { recursive: true });
    try {
      this.masterKey = await readFile(this.masterKeyFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.masterKey = randomBytes(32);
      await writeFile(this.masterKeyFile, this.masterKey, {
        mode: 0o600,
      });
      try {
        await chmod(this.masterKeyFile, 0o600);
      } catch {
        // Windows does not apply POSIX file modes.
      }
    }
    if (this.masterKey.length !== 32) {
      throw new Error("The MySQL encryption master key must contain 32 bytes.");
    }

    this.pool = mysql.createPool({
      uri: this.databaseUrl,
      connectionLimit: 8,
      enableKeepAlive: true,
      timezone: "Z",
    });
    await this.pool.query("SELECT 1");
    await this.ensureSchema();
  }

  async ensureSchema() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id CHAR(36) PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        display_name VARCHAR(80) NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    const [adminColumns] = await this.pool.query(
      "SHOW COLUMNS FROM users LIKE 'is_admin'",
    );
    if (adminColumns.length === 0) {
      await this.pool.query(
        "ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE AFTER display_name",
      );
    }
    const [disabledColumns] = await this.pool.query(
      "SHOW COLUMNS FROM users LIKE 'is_disabled'",
    );
    if (disabledColumns.length === 0) {
      await this.pool.query(
        "ALTER TABLE users ADD COLUMN is_disabled BOOLEAN NOT NULL DEFAULT FALSE AFTER is_admin",
      );
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS passkey_credentials (
        id VARCHAR(512) PRIMARY KEY,
        user_id CHAR(36) NOT NULL,
        public_key_jwk JSON NOT NULL,
        counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
        transports JSON NOT NULL,
        label VARCHAR(80) NOT NULL DEFAULT 'Passkey',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT fk_credentials_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    const [labelColumns] = await this.pool.query(
      "SHOW COLUMNS FROM passkey_credentials LIKE 'label'",
    );
    if (labelColumns.length === 0) {
      await this.pool.query(
        "ALTER TABLE passkey_credentials ADD COLUMN label VARCHAR(80) NOT NULL DEFAULT 'Passkey' AFTER transports",
      );
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id CHAR(36) PRIMARY KEY,
        name VARCHAR(80) NOT NULL,
        created_by CHAR(36) NOT NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT fk_workspace_creator
          FOREIGN KEY (created_by) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id CHAR(36) NOT NULL,
        user_id CHAR(36) NOT NULL,
        role ENUM('owner', 'editor', 'viewer') NOT NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (workspace_id, user_id),
        CONSTRAINT fk_membership_workspace
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_membership_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS workspace_data (
        workspace_id CHAR(36) PRIMARY KEY,
        format VARCHAR(40) NOT NULL,
        version INT NOT NULL,
        iv VARBINARY(12) NOT NULL,
        auth_tag VARBINARY(16) NOT NULL,
        ciphertext LONGBLOB NOT NULL,
        updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
          ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT fk_data_workspace
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS invitations (
        id CHAR(36) PRIMARY KEY,
        workspace_id CHAR(36) NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        role ENUM('editor', 'viewer') NOT NULL,
        created_by CHAR(36) NOT NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        expires_at TIMESTAMP(3) NOT NULL,
        used_at TIMESTAMP(3) NULL,
        CONSTRAINT fk_invitation_workspace
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_invitation_creator
          FOREIGN KEY (created_by) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
  }

  async close() {
    await this.pool?.end();
  }

  async hasUsers() {
    const [[row]] = await this.pool.query("SELECT COUNT(*) AS count FROM users");
    return Number(row.count) > 0;
  }

  async getUserByUsername(username) {
    const [rows] = await this.pool.query(
      "SELECT id, username, display_name AS displayName, is_admin AS isAdmin, is_disabled AS isDisabled FROM users WHERE username = ? LIMIT 1",
      [username],
    );
    return rows[0] || null;
  }

  async getUserById(id) {
    const [rows] = await this.pool.query(
      "SELECT id, username, display_name AS displayName, is_admin AS isAdmin, is_disabled AS isDisabled FROM users WHERE id = ? LIMIT 1",
      [id],
    );
    return rows[0] || null;
  }

  async getMemberships(userId) {
    const [rows] = await this.pool.query(
      `SELECT w.id AS workspaceId, w.name AS workspaceName, m.role
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ?
       ORDER BY m.created_at ASC`,
      [userId],
    );
    return rows;
  }

  async getMembership(userId, workspaceId) {
    const [rows] = await this.pool.query(
      `SELECT w.id AS workspaceId, w.name AS workspaceName, m.role
       FROM memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = ? AND m.workspace_id = ?
       LIMIT 1`,
      [userId, workspaceId],
    );
    return rows[0] || null;
  }

  async createWorkspace(userId, name, addOwner = true) {
    const workspaceId = randomUUID();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        "INSERT INTO workspaces (id, name, created_by) VALUES (?, ?, ?)",
        [workspaceId, name, userId],
      );
      if (addOwner) {
        await connection.query(
          "INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, 'owner')",
          [workspaceId, userId],
        );
      }
      await connection.commit();
      return {
        workspaceId,
        workspaceName: name,
        role: addOwner ? "owner" : null,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteWorkspace(workspaceId) {
    const [result] = await this.pool.query(
      "DELETE FROM workspaces WHERE id = ?",
      [workspaceId],
    );
    if (result.affectedRows === 0) {
      throw new Error("Workspace not found.");
    }
  }

  async listAllUsers() {
    const [rows] = await this.pool.query(
      `SELECT u.id, u.username, u.display_name AS displayName,
              u.is_admin AS isAdmin, u.created_at AS createdAt,
              u.is_disabled AS isDisabled,
              COUNT(DISTINCT c.id) AS passkeyCount,
              COUNT(DISTINCT m.workspace_id) AS workspaceCount
       FROM users u
       LEFT JOIN passkey_credentials c ON c.user_id = u.id
       LEFT JOIN memberships m ON m.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at ASC`,
    );
    return rows;
  }

  async setUserDisabled(adminUserId, userId, disabled) {
    if (adminUserId === userId) {
      throw new Error("The administrator cannot disable their own account.");
    }
    const [result] = await this.pool.query(
      "UPDATE users SET is_disabled = ? WHERE id = ?",
      [Boolean(disabled), userId],
    );
    if (result.affectedRows === 0) {
      throw new Error("User not found.");
    }
  }

  async listAllWorkspaces() {
    const [rows] = await this.pool.query(
      `SELECT w.id AS workspaceId, w.name AS workspaceName,
              w.created_at AS createdAt,
              COUNT(DISTINCT m.user_id) AS memberCount,
              COUNT(DISTINCT i.id) AS pendingInvitationCount
       FROM workspaces w
       LEFT JOIN memberships m ON m.workspace_id = w.id
       LEFT JOIN invitations i
         ON i.workspace_id = w.id
        AND i.used_at IS NULL
        AND i.expires_at > NOW(3)
       GROUP BY w.id
       ORDER BY w.created_at ASC`,
    );
    return rows;
  }

  async listAllInvitations() {
    const [rows] = await this.pool.query(
      `SELECT i.id, i.workspace_id AS workspaceId, w.name AS workspaceName,
              i.role, i.created_at AS createdAt, i.expires_at AS expiresAt
       FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.used_at IS NULL AND i.expires_at > NOW(3)
       ORDER BY i.created_at DESC`,
    );
    return rows;
  }

  async getCredentialsForUser(userId) {
    const [rows] = await this.pool.query(
      `SELECT id, public_key_jwk AS publicKeyJwk, counter, transports, label,
              created_at AS createdAt
       FROM passkey_credentials WHERE user_id = ?`,
      [userId],
    );
    return rows.map((row) => ({
      id: row.id,
      publicKeyJwk:
        typeof row.publicKeyJwk === "string"
          ? JSON.parse(row.publicKeyJwk)
          : row.publicKeyJwk,
      counter: Number(row.counter),
      transports:
        typeof row.transports === "string"
          ? JSON.parse(row.transports)
          : row.transports,
      label: row.label || "Passkey",
      createdAt: row.createdAt,
    }));
  }

  async getCredentialById(credentialId) {
    const [rows] = await this.pool.query(
      `SELECT id, user_id AS userId, public_key_jwk AS publicKeyJwk,
              counter, transports, label, created_at AS createdAt
       FROM passkey_credentials WHERE id = ? LIMIT 1`,
      [credentialId],
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      userId: rows[0].userId,
      publicKeyJwk:
        typeof rows[0].publicKeyJwk === "string"
          ? JSON.parse(rows[0].publicKeyJwk)
          : rows[0].publicKeyJwk,
      counter: Number(rows[0].counter),
      transports:
        typeof rows[0].transports === "string"
          ? JSON.parse(rows[0].transports)
          : rows[0].transports,
      label: rows[0].label || "Passkey",
      createdAt: rows[0].createdAt,
    };
  }

  async createInitialAccount({ user, credential }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query(
        "INSERT INTO users (id, username, display_name, is_admin) VALUES (?, ?, ?, TRUE)",
        [user.id, user.username, user.displayName],
      );
      await connection.query(
        `INSERT INTO passkey_credentials
          (id, user_id, public_key_jwk, counter, transports, label)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          credential.id,
          user.id,
          JSON.stringify(credential.publicKeyJwk),
          credential.counter,
          JSON.stringify(credential.transports),
          credential.label || "Primary passkey",
        ],
      );
      await connection.commit();
      return { workspaceId: null };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getInvitation(tokenHash) {
    const [rows] = await this.pool.query(
      `SELECT i.id, i.workspace_id AS workspaceId, i.role, i.expires_at AS expiresAt,
              i.used_at AS usedAt, w.name AS workspaceName
       FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.token_hash = ?
       LIMIT 1`,
      [tokenHash],
    );
    return rows[0] || null;
  }

  async createInvitation({ workspaceId, tokenHash, role, createdBy, expiresAt }) {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO invitations
        (id, workspace_id, token_hash, role, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, workspaceId, tokenHash, role, createdBy, expiresAt],
    );
    return id;
  }

  async listWorkspaceMembers(workspaceId) {
    const [rows] = await this.pool.query(
      `SELECT u.id, u.username, u.display_name AS displayName,
              m.role, m.created_at AS joinedAt
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ?
       ORDER BY FIELD(m.role, 'owner', 'editor', 'viewer'), m.created_at ASC`,
      [workspaceId],
    );
    return rows;
  }

  async updateMemberRole(workspaceId, userId, role) {
    if (!["editor", "viewer"].includes(role)) {
      throw new Error("Only editor or viewer roles can be assigned here.");
    }
    const [result] = await this.pool.query(
      `UPDATE memberships SET role = ?
       WHERE workspace_id = ? AND user_id = ? AND role <> 'owner'`,
      [role, workspaceId, userId],
    );
    if (result.affectedRows === 0) {
      throw new Error("The workspace owner's role cannot be changed.");
    }
  }

  async removeWorkspaceMember(workspaceId, userId) {
    const [result] = await this.pool.query(
      `DELETE FROM memberships
       WHERE workspace_id = ? AND user_id = ? AND role <> 'owner'`,
      [workspaceId, userId],
    );
    if (result.affectedRows === 0) {
      throw new Error("The workspace owner cannot be removed.");
    }
  }

  async listWorkspaceInvitations(workspaceId) {
    const [rows] = await this.pool.query(
      `SELECT id, role, created_at AS createdAt, expires_at AS expiresAt
       FROM invitations
       WHERE workspace_id = ?
         AND used_at IS NULL
         AND expires_at > NOW(3)
       ORDER BY created_at DESC`,
      [workspaceId],
    );
    return rows;
  }

  async revokeInvitation(workspaceId, invitationId) {
    const [result] = await this.pool.query(
      `UPDATE invitations SET used_at = NOW(3)
       WHERE id = ? AND workspace_id = ? AND used_at IS NULL`,
      [invitationId, workspaceId],
    );
    if (result.affectedRows === 0) {
      throw new Error("Invitation not found or already used.");
    }
  }

  async createInvitedAccount({ user, credential, invitationId }) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[invitation]] = await connection.query(
        `SELECT workspace_id AS workspaceId, role, expires_at AS expiresAt, used_at AS usedAt
         FROM invitations WHERE id = ? FOR UPDATE`,
        [invitationId],
      );
      if (!invitation || invitation.usedAt || new Date(invitation.expiresAt) <= new Date()) {
        throw new Error("This invitation is no longer valid.");
      }
      await connection.query(
        "INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)",
        [user.id, user.username, user.displayName],
      );
      await connection.query(
        `INSERT INTO passkey_credentials
          (id, user_id, public_key_jwk, counter, transports, label)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          credential.id,
          user.id,
          JSON.stringify(credential.publicKeyJwk),
          credential.counter,
          JSON.stringify(credential.transports),
          credential.label || "Passkey",
        ],
      );
      await connection.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES (?, ?, ?)",
        [invitation.workspaceId, user.id, invitation.role],
      );
      await connection.query("UPDATE invitations SET used_at = NOW(3) WHERE id = ?", [
        invitationId,
      ]);
      await connection.commit();
      return { workspaceId: invitation.workspaceId };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async joinWorkspace(userId, invitationId) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [[invitation]] = await connection.query(
        `SELECT workspace_id AS workspaceId, role, expires_at AS expiresAt, used_at AS usedAt
         FROM invitations WHERE id = ? FOR UPDATE`,
        [invitationId],
      );
      if (!invitation || invitation.usedAt || new Date(invitation.expiresAt) <= new Date()) {
        throw new Error("This invitation is invalid or has expired.");
      }
      await connection.query(
        `INSERT INTO memberships (workspace_id, user_id, role)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           role = CASE
             WHEN memberships.role = 'owner' THEN 'owner'
             ELSE VALUES(role)
           END`,
        [invitation.workspaceId, userId, invitation.role],
      );
      await connection.query("UPDATE invitations SET used_at = NOW(3) WHERE id = ?", [
        invitationId,
      ]);
      await connection.commit();
      const membership = await this.getMembership(userId, invitation.workspaceId);
      return membership;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateCredentialCounter(credentialId, counter) {
    await this.pool.query(
      "UPDATE passkey_credentials SET counter = ? WHERE id = ?",
      [counter, credentialId],
    );
  }

  async listPasskeys(userId) {
    const credentials = await this.getCredentialsForUser(userId);
    return credentials.map((credential) => ({
      id: credential.id,
      label: credential.label,
      createdAt: credential.createdAt,
    }));
  }

  async addPasskey(userId, credential) {
    await this.pool.query(
      `INSERT INTO passkey_credentials
        (id, user_id, public_key_jwk, counter, transports, label)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        credential.id,
        userId,
        JSON.stringify(credential.publicKeyJwk),
        credential.counter,
        JSON.stringify(credential.transports),
        credential.label || "Passkey",
      ],
    );
  }

  async deletePasskey(userId, credentialId) {
    const [rows] = await this.pool.query(
      "SELECT id FROM passkey_credentials WHERE user_id = ?",
      [userId],
    );
    if (rows.length <= 1) {
      throw new Error("Keep at least one passkey on your account.");
    }
    const [result] = await this.pool.query(
      "DELETE FROM passkey_credentials WHERE id = ? AND user_id = ?",
      [credentialId, userId],
    );
    if (result.affectedRows === 0) {
      throw new Error("Passkey not found.");
    }
  }

  deriveWorkspaceKey(workspaceId) {
    return Buffer.from(
      hkdfSync(
        "sha256",
        this.masterKey,
        Buffer.from(workspaceId),
        Buffer.from(encryptionFormat),
        32,
      ),
    );
  }

  async getWorkspaceState(workspaceId) {
    const [rows] = await this.pool.query(
      `SELECT format, version, iv, auth_tag AS authTag, ciphertext
       FROM workspace_data WHERE workspace_id = ?`,
      [workspaceId],
    );
    if (!rows[0]) {
      return emptyState();
    }
    const row = rows[0];
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.deriveWorkspaceKey(workspaceId),
        row.iv,
      );
      decipher.setAAD(Buffer.from(encryptionFormat));
      decipher.setAuthTag(row.authTag);
      const plaintext = Buffer.concat([
        decipher.update(row.ciphertext),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("Workspace data integrity validation failed.");
    }
  }

  async saveWorkspaceState(workspaceId, state) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.deriveWorkspaceKey(workspaceId),
      iv,
    );
    cipher.setAAD(Buffer.from(encryptionFormat));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state), "utf8"),
      cipher.final(),
    ]);
    await this.pool.query(
      `INSERT INTO workspace_data
        (workspace_id, format, version, iv, auth_tag, ciphertext)
       VALUES (?, ?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         format = VALUES(format),
         version = VALUES(version),
         iv = VALUES(iv),
         auth_tag = VALUES(auth_tag),
         ciphertext = VALUES(ciphertext)`,
      [
        workspaceId,
        encryptionFormat,
        iv,
        cipher.getAuthTag(),
        ciphertext,
      ],
    );
  }
}
