import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseJsonc } from "./parse-jsonc.mjs";

export const OTEL_KV_NAMESPACE_SENTINEL = "__OTEL_PAYLOAD_KV_NAMESPACE_ID__";
export const OTEL_D1_DATABASE_SENTINEL = "__OTEL_PAYLOAD_D1_DATABASE_ID__";
export const OTEL_R2_BINDING = {
  binding: "OTEL_OBJECTS",
  bucket_name: "graft-ai-aig-otel-v1",
};

const namespaceIdPattern = /^[0-9a-f]{32}$/i;
const d1DatabaseIdPattern =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const payloadStores = new Set(["kv", "r2", "d1"]);
const valueArguments = new Set([
  "--payload-store",
  "--kv-namespace-id",
  "--d1-database-id",
  "--output",
]);

export function renderOtelWorkerConfig(
  template,
  {
    kvNamespaceId,
    d1DatabaseId,
    payloadStore = "kv",
    includeR2Binding = false,
  } = {},
) {
  if (!payloadStores.has(payloadStore)) {
    throw new Error(
      `payloadStore must be one of: kv, r2, d1 (received ${payloadStore})`,
    );
  }
  if (!namespaceIdPattern.test(kvNamespaceId ?? "")) {
    throw new Error(
      "KV namespace ID must be exactly 32 hexadecimal characters",
    );
  }
  if (payloadStore === "r2" && !includeR2Binding) {
    throw new Error("R2 payloadStore requires the R2 binding");
  }
  if (payloadStore === "d1") {
    if (!d1DatabaseIdPattern.test(d1DatabaseId ?? "")) {
      throw new Error(
        "D1 database ID must be a valid 32-character hexadecimal or UUID string",
      );
    }
  }

  const templateBinding = template.kv_namespaces?.find(
    (entry) => entry.binding === "OTEL_PAYLOAD_KV",
  );
  if (templateBinding?.id !== OTEL_KV_NAMESPACE_SENTINEL) {
    throw new Error(
      "template must contain the OTEL_PAYLOAD_KV namespace ID sentinel",
    );
  }

  const templateD1Binding = template.d1_databases?.find(
    (entry) => entry.binding === "OTEL_PAYLOAD_D1",
  );
  if (templateD1Binding?.database_id !== OTEL_D1_DATABASE_SENTINEL) {
    throw new Error(
      "template must contain the OTEL_PAYLOAD_D1 database ID sentinel",
    );
  }

  const rendered = structuredClone(template);
  rendered.main = "../src/otel.ts";
  if (rendered.vars) {
    rendered.vars.OTEL_PAYLOAD_STORE = payloadStore;
  } else {
    rendered.vars = { OTEL_PAYLOAD_STORE: payloadStore };
  }
  rendered.kv_namespaces = [{ binding: "OTEL_PAYLOAD_KV", id: kvNamespaceId }];

  if (d1DatabaseId) {
    if (!d1DatabaseIdPattern.test(d1DatabaseId)) {
      throw new Error(
        "D1 database ID must be a valid 32-character hexadecimal or UUID string",
      );
    }
    rendered.d1_databases = [
      {
        binding: "OTEL_PAYLOAD_D1",
        database_name: templateD1Binding.database_name,
        database_id: d1DatabaseId,
      },
    ];
  } else {
    delete rendered.d1_databases;
  }

  if (includeR2Binding) {
    rendered.r2_buckets = [structuredClone(OTEL_R2_BINDING)];
  } else {
    delete rendered.r2_buckets;
  }

  return rendered;
}

function parseCliArgs(args) {
  const options = {
    payloadStore: "kv",
    includeR2Binding: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--include-r2-binding") {
      options.includeR2Binding = true;
      continue;
    }
    if (!valueArguments.has(argument))
      throw new Error(`unknown argument: ${argument}`);
    const value = readValueArgument(args, index, argument);
    index += 1;
    setValueOption(options, argument, value);
  }

  return requireCliOptions(options);
}

function readValueArgument(args, index, argument) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
}

function setValueOption(options, argument, value) {
  switch (argument) {
    case "--payload-store":
      options.payloadStore = value;
      return;
    case "--kv-namespace-id":
      options.kvNamespaceId = value;
      return;
    case "--d1-database-id":
      options.d1DatabaseId = value;
      return;
    case "--output":
      options.output = value;
      return;
    default:
      throw new Error(`unknown argument: ${argument}`);
  }
}

function requireCliOptions(options) {
  if (!options.kvNamespaceId) throw new Error("--kv-namespace-id is required");
  if (!options.output) throw new Error("--output is required");
  return options;
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const templatePath = resolve(
    import.meta.dirname,
    "../workers/wrangler.otel.jsonc",
  );
  const template = parseJsonc(readFileSync(templatePath, "utf8"));
  const rendered = renderOtelWorkerConfig(template, options);
  const outputPath = resolve(process.cwd(), options.output);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(rendered, null, 2)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) ===
    resolve(import.meta.dirname, "render-otel-worker-config.mjs")
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
