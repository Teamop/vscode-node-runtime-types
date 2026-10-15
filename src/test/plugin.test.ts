import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { readProjectNodeTypesVersion, typesLookupDirectory } from "../projectTypes";

interface FakeProject {
  directory: string;
  options: ts.CompilerOptions;
  hostRoot: string;
  cleared: boolean;
  dirty: boolean;
  refreshed: boolean;
  getCompilationSettings: () => ts.CompilerOptions;
  getCurrentDirectory: () => string;
  fileExists: (file: string) => boolean;
  readFile: (file: string) => string | undefined;
  directoryExists: (directory: string) => boolean;
  resolutionCache: { clear: () => void };
  markAsDirty: () => void;
  refreshDiagnostics: () => void;
  projectService: { logger: { info: (message: string) => void } };
}

function scoped(root: string): Pick<FakeProject, "fileExists" | "readFile" | "directoryExists"> {
  const prefix = path.normalize(root).toLowerCase();
  const allowed = (candidate: string) => path.normalize(candidate).toLowerCase().startsWith(prefix);
  return {
    fileExists: (file) => allowed(file) && ts.sys.fileExists(file),
    readFile: (file) => (allowed(file) ? ts.sys.readFile(file) : undefined),
    directoryExists: (directory) => allowed(directory) && Boolean(ts.sys.directoryExists?.(directory)),
  };
}

function fakeProject(directory: string, hostRoot: string, options: ts.CompilerOptions = { strict: true }): FakeProject {
  const project: FakeProject = {
    directory,
    options,
    hostRoot,
    cleared: false,
    dirty: false,
    refreshed: false,
    getCompilationSettings: () => project.options,
    getCurrentDirectory: () => directory,
    ...scoped(hostRoot),
    resolutionCache: { clear: () => { project.cleared = true; } },
    markAsDirty: () => { project.dirty = true; },
    refreshDiagnostics: () => { project.refreshed = true; },
    projectService: { logger: { info: () => undefined } },
  };
  return project;
}

function loadPlugin(): (modules: { typescript: typeof ts }) => {
  create: (info: { project: FakeProject; languageService: object; config: object }) => object;
  onConfigurationChanged: (config: unknown) => void;
} {
  // The plugin is loaded by tsserver from its own package.
  return require("../../plugin/index.js");
}

test("the plugin adds the runtime type root when the project has no Node types", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nrt-plugin-"));
  const projectDir = path.join(root, "app");
  const nested = path.join(projectDir, "pkg");
  const types24 = path.join(root, "cache24", "node_modules", "@types");
  const types25 = path.join(root, "cache25", "node_modules", "@types");
  mkdirSync(nested, { recursive: true });
  const plugin = loadPlugin()({ typescript: ts });
  const project = fakeProject(nested, root);
  plugin.create({ project, languageService: {}, config: {} });
  plugin.onConfigurationChanged({
    enabled: true,
    folders: [
      { path: projectDir, typesRoot: types24 },
      { path: nested, typesRoot: types25 },
    ],
  });
  const options = project.getCompilationSettings();
  assert.ok(options.typeRoots?.some((entry) => path.normalize(entry) === path.normalize(types25)));
  assert.deepEqual(options.types, ["node"]);
  assert.equal(project.dirty, true);
  assert.equal(project.refreshed, true);
  assert.equal(project.cleared, true);
});

test("TypeScript 5 leaves projects that already resolve @types/node unchanged", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nrt-owned-"));
  const typesPackage = path.join(root, "node_modules", "@types", "node");
  mkdirSync(typesPackage, { recursive: true });
  writeFileSync(path.join(typesPackage, "package.json"), JSON.stringify({ name: "@types/node", version: "24.2.0", types: "index.d.ts" }));
  writeFileSync(path.join(typesPackage, "index.d.ts"), "export {};\n");
  const typescript5 = new Proxy(ts, {
    get(target, property, receiver) {
      if (property === "version") {
        return "5.9.3";
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const plugin = loadPlugin()({ typescript: typescript5 });
  const project = fakeProject(root, root, { strict: true, moduleResolution: ts.ModuleResolutionKind.Node10 });
  plugin.create({ project, languageService: {}, config: {} });
  plugin.onConfigurationChanged({
    enabled: true,
    folders: [{ path: root, typesRoot: path.join(root, "cache", "node_modules", "@types") }],
  });
  const options = project.getCompilationSettings();
  assert.equal(options, project.options);
  assert.equal(options.typeRoots, undefined);
  assert.equal(readProjectNodeTypesVersion(root), "24.2.0");
});

test("TypeScript 6 lists node when the project already has the package", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nrt-ts6-"));
  const typesPackage = path.join(root, "node_modules", "@types", "node");
  mkdirSync(typesPackage, { recursive: true });
  writeFileSync(path.join(typesPackage, "package.json"), JSON.stringify({ name: "@types/node", version: "24.2.0", types: "index.d.ts" }));
  writeFileSync(path.join(typesPackage, "index.d.ts"), "export {};\n");
  const typescript6 = new Proxy(ts, {
    get(target, property, receiver) {
      if (property === "version") {
        return "6.0.3";
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const plugin = loadPlugin()({ typescript: typescript6 });
  const project = fakeProject(root, root, { strict: true, moduleResolution: ts.ModuleResolutionKind.Bundler });
  plugin.create({ project, languageService: {}, config: {} });
  plugin.onConfigurationChanged({
    enabled: true,
    folders: [{ path: root, typesRoot: path.join(root, "cache", "node_modules", "@types") }],
  });
  const options = project.getCompilationSettings();
  assert.deepEqual(options.types, ["node"]);
  assert.equal(options.typeRoots, undefined);
});

test("TypeScript 6 lists node when nothing was downloaded", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nrt-ts6-owned-"));
  const fileDirectory = path.join(root, "src");
  const typesPackage = path.join(root, "node_modules", "@types", "node");
  mkdirSync(typesPackage, { recursive: true });
  mkdirSync(fileDirectory, { recursive: true });
  writeFileSync(path.join(typesPackage, "package.json"), JSON.stringify({ name: "@types/node", version: "24.2.0", types: "index.d.ts" }));
  writeFileSync(path.join(typesPackage, "index.d.ts"), "export {};\n");
  const typescript6 = new Proxy(ts, {
    get(target, property, receiver) {
      if (property === "version") {
        return "6.0.3";
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const lookup = typesLookupDirectory(undefined, path.join(fileDirectory, "main.ts"));
  assert.equal(lookup && readProjectNodeTypesVersion(lookup), "24.2.0");
  const plugin = loadPlugin()({ typescript: typescript6 });
  const project = fakeProject(root, root, { strict: true, moduleResolution: ts.ModuleResolutionKind.Bundler });
  plugin.create({ project, languageService: {}, config: {} });
  plugin.onConfigurationChanged({ enabled: true, folders: [] });
  const options = project.getCompilationSettings();
  assert.deepEqual(options.types, ["node"]);
  assert.equal(options.typeRoots, undefined);
});

test("TypeScript 7 keeps the project's compiler options", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nrt-ts7-"));
  const typescript7 = new Proxy(ts, {
    get(target, property, receiver) {
      if (property === "version") {
        return "7.0.0";
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const plugin = loadPlugin()({ typescript: typescript7 });
  const project = fakeProject(root, root);
  plugin.create({ project, languageService: {}, config: {} });
  plugin.onConfigurationChanged({
    enabled: true,
    folders: [{ path: root, typesRoot: path.join(root, "cache", "node_modules", "@types") }],
  });
  assert.equal(project.getCompilationSettings(), project.options);
  assert.equal(project.options.typeRoots, undefined);
  assert.equal(project.options.types, undefined);
});

test("an unsupported configuration does not add type roots", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nrt-off-"));
  const plugin = loadPlugin()({ typescript: ts });
  const project = fakeProject(root, root);
  plugin.create({ project, languageService: {}, config: {} });
  plugin.onConfigurationChanged({ enabled: false, folders: [] });
  assert.equal(project.getCompilationSettings(), project.options);
});
