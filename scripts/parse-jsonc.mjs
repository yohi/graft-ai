import { readFileSync } from "node:fs";

function stripComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];

    if (inLineComment) {
      if (character === "\n") {
        inLineComment = false;
        output += character;
      }
      continue;
    }

    if (inBlockComment) {
      if (character === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (character === "\n") {
        output += character;
      }
      continue;
    }

    if (!inString && character === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (!inString && character === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += character;
    if (character === '"' && !escaped) {
      inString = !inString;
    }
    escaped = character === "\\" && !escaped;
    if (character !== "\\") {
      escaped = false;
    }
  }

  return output;
}

function stripTrailingCommas(input) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (character === '"' && !escaped) {
      inString = !inString;
    }

    if (!inString && character === ",") {
      let next = index + 1;
      while (/\s/.test(input[next] ?? "")) {
        next += 1;
      }
      if (input[next] === "}" || input[next] === "]") {
        escaped = false;
        continue;
      }
    }

    output += character;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") {
      escaped = false;
    }
  }

  return output;
}

export function parseJsonc(input) {
  return JSON.parse(stripTrailingCommas(stripComments(input)));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node scripts/parse-jsonc.mjs <file>");
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(parseJsonc(readFileSync(filePath, "utf8")))}\n`);
  }
}
