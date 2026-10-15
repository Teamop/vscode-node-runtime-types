/** Node.js 24.12 enables TypeScript type stripping by default. */
export const MIN_NODE_VERSION: NodeVersion = { major: 24, minor: 12, patch: 0, version: "24.12.0" };
export const MIN_NODE_LABEL = "24.12";

export interface NodeVersion {
  major: number;
  minor: number;
  patch: number;
  version: string;
}

export function parseNodeVersion(raw: string): NodeVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return undefined;
  }
  return { major, minor, patch, version: `${major}.${minor}.${patch}` };
}

export function isSupportedNodeVersion(version: Pick<NodeVersion, "major" | "minor" | "patch">): boolean {
  if (!Number.isInteger(version.major) || version.major < MIN_NODE_VERSION.major || version.major >= 1000) {
    return false;
  }
  if (version.major > MIN_NODE_VERSION.major) {
    return true;
  }
  if (version.minor !== MIN_NODE_VERSION.minor) {
    return version.minor > MIN_NODE_VERSION.minor;
  }
  return version.patch >= MIN_NODE_VERSION.patch;
}

export function isSupportedNodeMajor(major: number): boolean {
  return Number.isInteger(major) && major >= MIN_NODE_VERSION.major && major < 1000;
}

/**
 * Picks the @types/node major that matches the runtime.
 * Newer published majors are ignored so the editor does not advertise APIs
 * the runtime cannot run. When the exact major is unpublished, the newest
 * older Node 24+ package is used.
 */
export function selectTypesMajor(runtimeMajor: number, publishedMajors: readonly number[]): number | undefined {
  if (!isSupportedNodeMajor(runtimeMajor)) {
    return undefined;
  }
  const eligible = publishedMajors.filter((major) => isSupportedNodeMajor(major) && major <= runtimeMajor);
  if (eligible.length === 0) {
    return undefined;
  }
  return Math.max(...eligible);
}

export function quoteShellArg(value: string, powershell: boolean): string {
  if (powershell) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function formatRunCommand(shellPath: string, nodePath: string, file: string): string {
  const powershell = /powershell|pwsh/i.test(shellPath);
  const node = quoteShellArg(nodePath, powershell);
  const target = quoteShellArg(file, powershell);
  return powershell ? `& ${node} ${target}` : `${node} ${target}`;
}
