import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The opened workspace folder is the TypeScript project.
 * A file with no workspace folder is checked from its own directory.
 */
export function typesLookupDirectory(folderPath: string | undefined, filePath: string | undefined): string | undefined {
  if (folderPath) {
    return folderPath;
  }
  if (!filePath) {
    return undefined;
  }
  return path.dirname(path.resolve(filePath));
}

export function readProjectNodeTypesVersion(startDirectory: string): string | undefined {
  let directory = path.resolve(startDirectory);
  const root = path.parse(directory).root;
  while (true) {
    const packageJson = path.join(directory, "node_modules", "@types", "node", "package.json");
    if (existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" ? parsed.version : undefined;
      } catch {
        return undefined;
      }
    }
    if (directory === root) {
      return undefined;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}
