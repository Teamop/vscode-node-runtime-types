import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isSupportedNodeMajor, parseNodeVersion, selectTypesMajor } from "./policy";
import { enqueue } from "./queue";
import { runNpm } from "./runtime";

export interface InstalledNodeTypes {
  typesMajor: number;
  typesVersion: string;
  typesRoot: string;
  runtimeMajor: number;
}

export async function ensureNodeTypes(
  storageDir: string,
  runtimeMajor: number,
  nodeExecPath: string,
  force = false,
): Promise<InstalledNodeTypes> {
  if (!isSupportedNodeMajor(runtimeMajor)) {
    throw new Error(`Node.js ${runtimeMajor} is not supported. Node Runtime Types requires Node.js 24.12 or newer.`);
  }
  const typesMajor = await publishedTypesMajor(nodeExecPath, runtimeMajor);
  if (typesMajor === undefined) {
    throw new Error(`No @types/node package is published for Node.js ${runtimeMajor}. Node.js 24.12 or newer is required.`);
  }
  const prefix = path.join(storageDir, `node-${typesMajor}`);
  return enqueue(path.resolve(prefix), () => installNodeTypes(prefix, typesMajor, runtimeMajor, nodeExecPath, force));
}

async function installNodeTypes(
  prefix: string,
  typesMajor: number,
  runtimeMajor: number,
  nodeExecPath: string,
  force: boolean,
): Promise<InstalledNodeTypes> {
  const packageJsonPath = path.join(prefix, "node_modules", "@types", "node", "package.json");
  if (!force) {
    const cached = await readTypesVersion(packageJsonPath);
    if (cached && parseNodeVersion(cached)?.major === typesMajor) {
      return {
        typesMajor,
        typesVersion: cached,
        typesRoot: path.join(prefix, "node_modules", "@types"),
        runtimeMajor,
      };
    }
  }
  await rm(prefix, { recursive: true, force: true });
  await mkdir(prefix, { recursive: true });
  await runNpm(nodeExecPath, [
    "install",
    `@types/node@${typesMajor}`,
    "--prefix",
    prefix,
    "--ignore-scripts",
    "--no-fund",
    "--no-audit",
    "--loglevel=error",
  ]);
  const typesVersion = await readTypesVersion(packageJsonPath);
  if (!typesVersion) {
    throw new Error(`npm installed @types/node@${typesMajor}, but package.json was not found.`);
  }
  return {
    typesMajor,
    typesVersion,
    typesRoot: path.join(prefix, "node_modules", "@types"),
    runtimeMajor,
  };
}

async function publishedTypesMajor(nodeExecPath: string, runtimeMajor: number): Promise<number | undefined> {
  if (await packageExists(nodeExecPath, runtimeMajor)) {
    return runtimeMajor;
  }
  const stdout = await runNpm(nodeExecPath, ["view", "@types/node", "version", "--json"], 60_000);
  const versions = parseVersionList(stdout);
  const majors = versions.flatMap((version) => {
    const parsed = parseNodeVersion(version);
    return parsed ? [parsed.major] : [];
  });
  return selectTypesMajor(runtimeMajor, majors);
}

async function packageExists(nodeExecPath: string, major: number): Promise<boolean> {
  try {
    const stdout = await runNpm(nodeExecPath, ["view", `@types/node@${major}`, "version"], 60_000);
    return parseNodeVersion(stdout)?.major === major;
  } catch {
    return false;
  }
}

export function parseVersionList(stdout: string): string[] {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\d+\.\d+/.test(line));
}

async function readTypesVersion(packageJsonPath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}
