import { describe, it, expect } from "vitest";
import { importRsaPrivateKey, decryptField, decryptIfEncrypted } from "../src/crypto";
import type { EncryptedField } from "../src/types";

// Generate a test RSA key pair inside the Workers runtime
async function generateTestKeyPair(): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;

  const privateKeyDer = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
  const publicKeyDer = (await crypto.subtle.exportKey("spki", keyPair.publicKey)) as ArrayBuffer;

  const privateKeyPem = pemEncode(privateKeyDer, "PRIVATE KEY");
  const publicKeyPem = pemEncode(publicKeyDer, "PUBLIC KEY");

  return { privateKeyPem, publicKeyPem };
}

function pemEncode(der: ArrayBuffer, type: string): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [base64];
  return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----`;
}

// Encrypt a string using hybrid encryption (RSA-OAEP + AES-GCM) matching Cloudflare's scheme
async function encryptForTest(publicKeyPem: string, plaintext: string): Promise<EncryptedField> {
  const pubKey = await crypto.subtle.importKey(
    "spki",
    derFromPem(publicKeyPem, "PUBLIC KEY"),
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"],
  );

  const aesKey = (await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKey;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    encoder.encode(plaintext),
  );

  const aesKeyRaw = (await crypto.subtle.exportKey("raw", aesKey)) as ArrayBuffer;
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    pubKey,
    aesKeyRaw,
  );

  return {
    key: base64Encode(wrappedKey),
    iv: base64Encode(iv.buffer),
    data: base64Encode(ciphertext),
  };
}

function derFromPem(pem: string, type: string): ArrayBuffer {
  const header = `-----BEGIN ${type}-----`;
  const footer = `-----END ${type}-----`;
  const b64 = pem.substring(header.length, pem.length - footer.length).replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64Encode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("crypto module", () => {
  it("imports an RSA PKCS#8 private key from PEM", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const key = await importRsaPrivateKey(privateKeyPem);
    expect(key).toBeDefined();
    expect(key.algorithm.name).toBe("RSA-OAEP");
  });

  it("decrypts an encrypted field back to original plaintext", async () => {
    const { privateKeyPem, publicKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const original = '{"model":"llama-3.1-8b","tokens":230}';
    const encrypted = await encryptForTest(publicKeyPem, original);
    const decrypted = await decryptField(privateKey, encrypted);
    expect(decrypted).toBe(original);
  });

  it("decryptIfEncrypted returns plaintext string for EncryptedField", async () => {
    const { privateKeyPem, publicKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const original = "hello world";
    const encrypted = await encryptForTest(publicKeyPem, original);
    const result = await decryptIfEncrypted(privateKey, encrypted);
    expect(result).toBe("hello world");
  });

  it("decryptIfEncrypted returns value as-is when not encrypted", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const result = await decryptIfEncrypted(privateKey, "plain string value");
    expect(result).toBe("plain string value");
  });

  it("decryptIfEncrypted returns a plain object with non-base64 encryption-shaped fields as-is", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const shapedButPlain = { key: "not-base64!", iv: "iv", data: "data" };

    const result = await decryptIfEncrypted(privateKey, shapedButPlain);

    expect(result).toEqual(shapedButPlain);
  });

  it("decryptIfEncrypted returns a partial encryption-shaped object as-is", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const partial = { key: "abc", data: "def" };

    const result = await decryptIfEncrypted(privateKey, partial);

    expect(result).toEqual(partial);
  });

  it("decryptIfEncrypted returns null as-is", async () => {
    const { privateKeyPem } = await generateTestKeyPair();
    const privateKey = await importRsaPrivateKey(privateKeyPem);
    const result = await decryptIfEncrypted(privateKey, null);
    expect(result).toBe(null);
  });
});
