import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedSecret {
  ciphertext: Buffer;
  keyVersion: string;
}

export class OAuthTokenCipher {
  constructor(
    private readonly key: Buffer,
    private readonly keyVersion: string
  ) {
    if (key.length !== 32) {
      throw new Error("OAuth token encryption key must be exactly 32 bytes");
    }
  }

  encrypt(token: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: Buffer.concat([Buffer.from([1]), iv, authTag, ciphertext]),
      keyVersion: this.keyVersion
    };
  }

  decrypt(secret: EncryptedSecret): string {
    if (secret.keyVersion !== this.keyVersion) {
      throw new Error("Encrypted OAuth token uses an unavailable key version");
    }
    if (secret.ciphertext.length < 30 || secret.ciphertext[0] !== 1) {
      throw new Error("Encrypted OAuth token has an unsupported format");
    }

    const iv = secret.ciphertext.subarray(1, 13);
    const authTag = secret.ciphertext.subarray(13, 29);
    const ciphertext = secret.ciphertext.subarray(29);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
