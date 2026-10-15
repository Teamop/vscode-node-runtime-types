import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const sample = `
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readPackageVersion(): Promise<string> {
  const file = join(process.cwd(), "package.json");
  const text = await readFile(file, "utf8");
  return process.version + ":" + text.length;
}
`;

function diagnostics(root: string, withTypes: boolean): string[] {
  const file = path.join(root, "app.ts");
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
  };
  if (withTypes) {
    options.typeRoots = [path.resolve(__dirname, "../../node_modules/@types")];
    options.types = ["node"];
  } else {
    options.typeRoots = [];
    options.types = [];
  }
  writeFileSync(file, sample);
  const program = ts.createProgram([file], options);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file && path.normalize(diagnostic.file.fileName) === path.normalize(file))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

test("Node built-in imports fail without types and pass with the runtime type root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nrt-check-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }));
  const missing = diagnostics(root, false);
  assert.ok(missing.some((message) => message.includes("node:fs/promises")), missing.join("\n"));
  const found = diagnostics(root, true);
  assert.deepEqual(found, [], found.join("\n"));
});
