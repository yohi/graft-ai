import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function stripComments(input) {
  return input.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (match, stringLiteral) => {
    if (stringLiteral) {
      return stringLiteral;
    }
    return match.startsWith("/*") && match.includes("\n") ? "\n".repeat((match.match(/\n/g) || []).length) : "";
  });
}

export function stripTrailingCommas(input) {
  return input.replace(/("(?:\\.|[^"\\])*")|,\s*([\]}])/g, (match, stringLiteral, closingBracket) => {
    return stringLiteral || closingBracket;
  });
}

export function parseJsonc(input) {
  return JSON.parse(stripTrailingCommas(stripComments(input)));
}

export function validateAndResolvePath(rawPath, baseDir = process.cwd()) {
  if (!rawPath || typeof rawPath !== "string") {
    throw new Error("Path must be a non-empty string");
  }
  if (rawPath.includes("\0")) {
    throw new Error("Path must not contain null bytes");
  }
  const resolvedBase = resolve(baseDir);
  const targetPath = resolve(resolvedBase, rawPath);
  const rel = relative(resolvedBase, targetPath);
  if (rel.startsWith("..") || isAbsolute(rel) || (!targetPath.startsWith(resolvedBase + sep) && targetPath !== resolvedBase)) {
    throw new Error("Path traversal detected: path must be within base directory");
  }
  return targetPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/parse-jsonc.mjs <file>");
    process.exitCode = 1;
  } else {
    try {
      const targetPath = validateAndResolvePath(filePath);
      process.stdout.write(`${JSON.stringify(parseJsonc(readFileSync(targetPath, "utf8")))}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
