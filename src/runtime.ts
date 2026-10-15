import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseNodeVersion, type NodeVersion } from "./policy";

export interface NodeRuntime extends NodeVersion {
  execPath: string;
}

export function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function run(command: string, args: string[], cwd?: string, timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    execFile(
      command,
      shell ? args.map(quoteCmdArg) : args,
      { cwd, timeout, windowsHide: true, encoding: "utf8", shell },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr || ""}`.trim() || error.message;
          reject(new Error(`${command} ${args.join(" ")} failed: ${detail}`));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

export function quoteCmdArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s"]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/** Runs npm with the Node executable that was detected, avoiding cmd shims. */
export function npmInvocation(nodeExecPath: string, args: string[]): { command: string; args: string[] } {
  const cli = path.join(path.dirname(nodeExecPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(cli)) {
    return { command: nodeExecPath, args: [cli, ...args] };
  }
  return { command: npmExecutable(), args };
}

export async function runNpm(nodeExecPath: string, args: string[], timeout = 120_000): Promise<string> {
  const invocation = npmInvocation(nodeExecPath, args);
  return run(invocation.command, invocation.args, undefined, timeout);
}

export async function detectNodeRuntime(nodePath: string | undefined, cwd: string | undefined): Promise<NodeRuntime> {
  const executable = nodePath && nodePath.trim().length > 0 ? nodePath.trim() : "node";
  const stdout = await run(executable, ["-p", "process.execPath + '\\n' + process.version"], cwd, 15_000);
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const version = parseNodeVersion(lines[lines.length - 1] ?? "");
  const execPath = lines.length >= 2 ? lines[0] : executable;
  if (!version || !execPath) {
    throw new Error(`Unable to read a Node.js version from \`${executable}\`.`);
  }
  return { ...version, execPath };
}
