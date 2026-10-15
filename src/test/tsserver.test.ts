import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const sample = `
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readPackageVersion(): Promise<string> {
  const file = join(process.cwd(), "package.json");
  const text = await readFile(file, "utf8");
  return process.version + ":" + text.length;
}
`;

test("tsserver uses the runtime Node types for an inferred project", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nrt-server-"));
  const file = path.join(root, "app.ts");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", private: true, type: "module" }));
  writeFileSync(file, sample);
  const typesRoot = path.resolve(__dirname, "../../node_modules/@types");
  const extensionRoot = path.resolve(__dirname, "../..");
  const logFile = path.join(root, "tsserver.log");
  const server = spawn(
    process.execPath,
    [
      path.join(extensionRoot, "node_modules", "typescript", "lib", "tsserver.js"),
      "--useInferredProjectPerProjectRoot",
      "--globalPlugins",
      "node-runtime-types-plugin",
      "--pluginProbeLocations",
      extensionRoot,
      "--logFile",
      logFile,
      "--logVerbosity",
      "verbose",
      "--disableAutomaticTypingAcquisition",
    ],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );

  const messages: Array<{ type?: string; event?: string; command?: string; body?: unknown; success?: boolean; message?: string }> = [];
  let buffer = Buffer.alloc(0);
  server.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"))?.[1]);
      if (!Number.isInteger(length)) {
        return;
      }
      const start = headerEnd + 4;
      if (buffer.length < start + length) {
        return;
      }
      messages.push(JSON.parse(buffer.subarray(start, start + length).toString("utf8")));
      buffer = buffer.subarray(start + length);
    }
  });
  let stderr = "";
  server.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  let sequence = 1;
  const send = (command: string, args: object) => {
    server.stdin.write(`${JSON.stringify({ seq: sequence++, type: "request", command, arguments: args })}\n`);
  };

  try {
    send("compilerOptionsForInferredProjects", {
      options: {
        strict: true,
        target: "esnext",
        module: "nodenext",
        moduleResolution: "nodenext",
        noEmit: true,
        typeRoots: [],
        types: [],
        enable: false,
      },
      projectRootPath: root,
    });
    send("configurePlugin", {
      pluginName: "node-runtime-types-plugin",
      configuration: {
        enabled: true,
        typesRoot,
        folders: [{ path: root, typesRoot }],
      },
    });
    send("updateOpen", {
      openFiles: [{ file, fileContent: sample, scriptKindName: "TS", projectRootPath: root }],
    });

    const started = Date.now();
    let diagnostics: Array<{ text?: string; code?: number }> | undefined;
    while (Date.now() - started < 15_000) {
      send("geterr", { delay: 0, files: [file] });
      await delay(250);
      diagnostics = semanticDiagnostics(messages, file);
      if (diagnostics && diagnostics.length === 0) {
        return;
      }
    }
    assert.deepEqual(diagnostics ?? messages.slice(-8), [], `${stderr}\n${JSON.stringify(diagnostics ?? messages.slice(-12), null, 2)}`);
  } finally {
    server.kill();
    await onceExit(server);
  }
});

function semanticDiagnostics(
  messages: Array<{ event?: string; body?: unknown }>,
  file: string,
): Array<{ text?: string; code?: number }> | undefined {
  const target = path.normalize(file).toLowerCase();
  let found: Array<{ text?: string; code?: number }> | undefined;
  for (const message of messages) {
    if (message.event !== "semanticDiag" || !message.body || typeof message.body !== "object") {
      continue;
    }
    const body = message.body as { file?: string; diagnostics?: Array<{ text?: string; code?: number }> };
    if (!body.file || path.normalize(body.file).toLowerCase() !== target) {
      continue;
    }
    found = body.diagnostics ?? [];
  }
  return found;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceExit(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => server.once("exit", () => resolve()));
}
