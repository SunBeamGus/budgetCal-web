import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const encryptionFormat = "budget-cal-host-state";

export function emptyHostState() {
  return {
    settings: null,
    categories: [],
    allocations: [],
    transactions: [],
    assets: [],
    groupBudgets: [],
  };
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export class EncryptedHostStore {
  constructor(directory) {
    this.directory = directory;
    this.dataFile = join(directory, "budget-cal.enc.json");
    this.keyFile = join(directory, "budget-cal.key");
    this.key = null;
    this.state = emptyHostState();
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true });
    const dataExists = await fileExists(this.dataFile);
    const keyExists = await fileExists(this.keyFile);
    if (dataExists && !keyExists) {
      throw new Error(
        "The encrypted host data exists but its local key file is missing. Restore both files from backup.",
      );
    }
    if (!keyExists) {
      this.key = randomBytes(32);
      await writeFile(this.keyFile, this.key.toString("base64"), {
        encoding: "utf8",
        mode: 0o600,
      });
      try {
        await chmod(this.keyFile, 0o600);
      } catch {
        // Windows does not apply POSIX file modes.
      }
    } else {
      const encodedKey = (await readFile(this.keyFile, "utf8")).trim();
      this.key = Buffer.from(encodedKey, "base64");
      if (this.key.length !== 32) {
        throw new Error("The host encryption key file is invalid.");
      }
    }

    if (dataExists) {
      this.state = this.decrypt(JSON.parse(await readFile(this.dataFile, "utf8")));
    } else {
      await this.writeRaw(this.state);
    }
  }

  encrypt(state) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(encryptionFormat));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(state), "utf8"),
      cipher.final(),
    ]);
    return {
      format: encryptionFormat,
      version: 1,
      cipher: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      savedAt: new Date().toISOString(),
    };
  }

  decrypt(payload) {
    if (
      payload?.format !== encryptionFormat ||
      payload?.version !== 1 ||
      payload?.cipher !== "aes-256-gcm"
    ) {
      throw new Error("Unsupported or invalid encrypted host data.");
    }
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(payload.iv, "base64"),
      );
      decipher.setAAD(Buffer.from(encryptionFormat));
      decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("Host data integrity check failed. The file may have been modified.");
    }
  }

  async writeRaw(state) {
    const temporaryFile = `${this.dataFile}.${process.pid}.tmp`;
    await writeFile(temporaryFile, JSON.stringify(this.encrypt(state), null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await chmod(temporaryFile, 0o600);
    } catch {
      // Windows does not apply POSIX file modes.
    }
    await rename(temporaryFile, this.dataFile);
  }

  async save(state) {
    this.writeQueue = this.writeQueue.then(() => this.writeRaw(state));
    await this.writeQueue;
    this.state = state;
  }
}
