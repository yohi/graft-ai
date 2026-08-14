import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const verifierSource = new URL("../scripts/verify-terraform-logpush-fields.mjs", import.meta.url);
const allFields = [
  "RequestID",
  "RequestTime",
  "CacheStatus",
  "StatusCode",
  "Model",
  "PromptTokens",
  "CompletionTokens",
  "TotalTokens",
  "RequestDuration",
  "Path",
  "Method",
  "Metadata",
  "RequestBody",
  "ResponseBody",
];

test("checks the repository Terraform field contract", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/verify-terraform-logpush-fields.mjs"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.equal(output, "All 14 required fields present.\n");
});

function withVerifierFixture(fieldNames, check) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "graft-ai-logpush-fields-"));
  try {
    mkdirSync(join(fixtureRoot, "scripts"));
    mkdirSync(join(fixtureRoot, "terraform"));
    cpSync(verifierSource, join(fixtureRoot, "scripts", "verify-terraform-logpush-fields.mjs"));
    writeFileSync(
      join(fixtureRoot, "terraform", "main.tf"),
      `field_names = [\n${fieldNames.map((field) => `  "${field}",`).join("\n")}\n]\n`,
    );
    check(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

test("reports success only when all 14 Logpush fields are configured", () => {
  withVerifierFixture(allFields, (fixtureRoot) => {
    const output = execFileSync(
      process.execPath,
      ["scripts/verify-terraform-logpush-fields.mjs"],
      { cwd: fixtureRoot, encoding: "utf8" },
    );

    assert.equal(output, "All 14 required fields present.\n");
  });
});

test("rejects a field_names block missing a required encrypted payload field", () => {
  withVerifierFixture(
    allFields.filter((field) => field !== "ResponseBody"),
    (fixtureRoot) => {
      assert.throws(
        () =>
          execFileSync(process.execPath, ["scripts/verify-terraform-logpush-fields.mjs"], {
            cwd: fixtureRoot,
            encoding: "utf8",
            stdio: "pipe",
          }),
        (error) => {
          assert.equal(error.status, 1);
          assert.match(error.stderr, /Missing required Logpush fields: ResponseBody/);
          return true;
        },
      );
    },
  );
});

test("does not count quoted field names inside HCL comments", () => {
  withVerifierFixture(
    allFields.filter((field) => field !== "ResponseBody"),
    (fixtureRoot) => {
      writeFileSync(
        join(fixtureRoot, "terraform", "main.tf"),
        `field_names = [
  ${allFields.filter((field) => field !== "ResponseBody").map((field) => `"${field}",`).join("\n  ")}
  # "ResponseBody"
]
`,
      );
      assert.throws(
        () =>
          execFileSync(process.execPath, ["scripts/verify-terraform-logpush-fields.mjs"], {
            cwd: fixtureRoot,
            encoding: "utf8",
            stdio: "pipe",
          }),
        (error) => {
          assert.equal(error.status, 1);
          assert.match(error.stderr, /Missing required Logpush fields: ResponseBody/);
          return true;
        },
      );
    },
  );
});

test("does not select a field_names block inside an HCL block comment", () => {
  withVerifierFixture(
    allFields.filter((field) => field !== "ResponseBody"),
    (fixtureRoot) => {
      const commentedFields = allFields.map((field) => `  "${field}",`).join("\n");
      const actualFields = allFields
        .filter((field) => field !== "ResponseBody")
        .map((field) => `  "${field}",`)
        .join("\n");
      writeFileSync(
        join(fixtureRoot, "terraform", "main.tf"),
        `/* field_names = [
${commentedFields}
] */
field_names = [
${actualFields}
]
`,
      );
      assert.throws(
        () =>
          execFileSync(process.execPath, ["scripts/verify-terraform-logpush-fields.mjs"], {
            cwd: fixtureRoot,
            encoding: "utf8",
            stdio: "pipe",
          }),
        (error) => {
          assert.equal(error.status, 1);
          assert.match(error.stderr, /Missing required Logpush fields: ResponseBody/);
          return true;
        },
      );
    },
  );
});
