import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseJsonc, validateAndResolvePath } from "../scripts/parse-jsonc.mjs";

test("parseJsonc preserves strings while removing comments and trailing commas", () => {
  const config = parseJsonc(`
    {
      // A comment before the configuration.
      "url": "https://example.test/api/*",
      "message": "quoted \\\"text\\\" // not a comment",
      "items": [
        "first",
        "second",
      ],
    }
  `);

  assert.deepEqual(config, {
    url: "https://example.test/api/*",
    message: 'quoted "text" // not a comment',
    items: ["first", "second"],
  });
});

test("parseJsonc removes block comments without changing line structure", () => {
  assert.deepEqual(
    parseJsonc('{\n  /* inline comment */\n  "enabled": true,\n}'),
    { enabled: true },
  );
});

test("validateAndResolvePath normalizes and rejects invalid paths", () => {
  assert.throws(() => validateAndResolvePath(""), /non-empty string/);
  assert.throws(() => validateAndResolvePath(null), /non-empty string/);
  assert.throws(() => validateAndResolvePath("test\0bad.jsonc"), /null bytes/);
  const resolved = validateAndResolvePath("scripts/parse-jsonc.mjs");
  assert.ok(resolved.endsWith("scripts/parse-jsonc.mjs"));
});

test("parseJsonc parses actual repository wrangler configs", () => {
  const proxyJsonc = readFileSync(fileURLToPath(new URL("../workers/wrangler.proxy.jsonc", import.meta.url)), "utf8");
  const parsed = parseJsonc(proxyJsonc);
  assert.equal(parsed.name, "graft-ai-aig-proxy");
});

test("parseJsonc CLI works when executed directly", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/parse-jsonc.mjs", import.meta.url));
  const tempFilePath = join(tmpdir(), `test-config-${Date.now()}.jsonc`);
  try {
    writeFileSync(tempFilePath, '{\n  // comment\n  "key": "value",\n}');
    const stdout = execFileSync(process.execPath, [scriptPath, tempFilePath], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(stdout), { key: "value" });
  } finally {
    try {
      unlinkSync(tempFilePath);
    } catch {}
  }
});
