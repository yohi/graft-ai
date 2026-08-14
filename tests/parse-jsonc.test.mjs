import assert from "node:assert/strict";
import test from "node:test";

import { parseJsonc } from "../scripts/parse-jsonc.mjs";

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
