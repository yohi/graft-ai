import { isEncryptedField, type EncryptedField } from "./types";

function pemToDer(pem: string): ArrayBuffer {
  const lines = pem
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("-----"));
  const base64 = lines.join("");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function decryptField(
  privateKey: CryptoKey,
  field: EncryptedField,
): Promise<string> {
  // 1. Unwrap AES-GCM key using RSA-OAEP-SHA256
  const wrappedKeyBuf = base64ToUint8Array(field.key);
  const aesKeyRaw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    wrappedKeyBuf,
  );

  const aesKey = await crypto.subtle.importKey(
    "raw",
    aesKeyRaw,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );

  // 2. Decrypt the data using AES-GCM
  const iv = base64ToUint8Array(field.iv);
  const ciphertext = base64ToUint8Array(field.data);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext,
  );

  return new TextDecoder().decode(decrypted);
}

export async function tryDecryptField(
  privateKey: CryptoKey,
  value: unknown,
): Promise<unknown> {
  if (value === null || value === undefined) {
    return value;
  }
  if (!isEncryptedField(value)) {
    return value;
  }
  try {
    return await decryptField(privateKey, value);
  } catch (err) {
    // If decryption fails, the value is not actually encrypted; return it as-is
    // so a single malformed field does not drop the entire log line.
    console.error(
      `Failed to decrypt field: ${err instanceof Error ? err.message : String(err)}`,
    );
    return value;
  }
}
