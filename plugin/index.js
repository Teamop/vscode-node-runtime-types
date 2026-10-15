"use strict";

const fs = require("fs");
const path = require("path");

/**
 * TypeScript loads @types packages from `typeRoots`. Projects that do not
 * depend on @types/node otherwise report "Cannot find module 'node:fs'".
 * getExternalFiles does not add files to the program, so this plugin
 * appends a runtime-matched @types directory through getCompilationSettings.
 *
 * @param {{ typescript: typeof import("typescript") }} modules
 */
function init(modules) {
  const ts = modules.typescript;
  /** @type {PluginState} */
  let state = { enabled: false, generation: 0, folders: [] };
  /** @type {Set<ProjectLike>} */
  const projects = new Set();

  /**
   * @param {ProjectLike} project
   */
  function install(project) {
    if (project.__nodeRuntimeTypesWrapped) {
      return;
    }
    const original = project.getCompilationSettings.bind(project);
    project.__nodeRuntimeTypesOriginal = original;
    const wrapped = () => compilationSettings(project, original);
    project.getCompilationSettings = wrapped;
    if (typeof project.getCompilerOptions === "function") {
      project.getCompilerOptions = wrapped;
    }
    project.__nodeRuntimeTypesWrapped = true;
    projects.add(project);
  }

  /**
   * @param {ProjectLike} project
   * @param {() => import("typescript").CompilerOptions} original
   */
  function compilationSettings(project, original) {
    const base = original() || {};
    if (!state.enabled || !supportsTypeScript(ts)) {
      return base;
    }
    const typesRoot = typesRootFor(project.getCurrentDirectory());
    const hasNodeTypes = lookupNodeTypes(ts, project, base);
    const listNode = needsNodeInTypesList(ts, base);
    if (!hasNodeTypes && !typesRoot) {
      return base;
    }
    if (!listNode && hasNodeTypes) {
      return base;
    }
    if (
      project.__nodeRuntimeTypesBase === base &&
      project.__nodeRuntimeTypesHas === hasNodeTypes &&
      project.__nodeRuntimeTypesList === listNode &&
      project.__nodeRuntimeTypesRoot === typesRoot &&
      project.__nodeRuntimeTypesGeneration === state.generation &&
      project.__nodeRuntimeTypesValue
    ) {
      return project.__nodeRuntimeTypesValue;
    }
    const derived = deriveOptions(ts, project, base, typesRoot, hasNodeTypes, listNode);
    const decision = `${state.generation}:${typesRoot}:${hasNodeTypes ? "resolved" : "missing"}:${listNode ? "list" : "keep"}`;
    if (project.__nodeRuntimeTypesDecision !== decision) {
      project.__nodeRuntimeTypesDecision = decision;
      logger(project).info(
        derived === base
          ? "[node-runtime-types] project already includes @types/node"
          : `[node-runtime-types] including node types from ${hasNodeTypes ? "the project" : path.normalize(typesRoot)}`,
      );
    }
    project.__nodeRuntimeTypesList = listNode;
    project.__nodeRuntimeTypesBase = base;
    project.__nodeRuntimeTypesHas = hasNodeTypes;
    project.__nodeRuntimeTypesRoot = typesRoot;
    project.__nodeRuntimeTypesGeneration = state.generation;
    project.__nodeRuntimeTypesValue = derived;
    return derived;
  }

  /**
   * @param {string} currentDirectory
   */
  function typesRootFor(currentDirectory) {
    const folders = state.folders.filter((folder) => folder.typesRoot);
    let best;
    for (const folder of folders) {
      if (!isInside(folder.path, currentDirectory)) {
        continue;
      }
      if (!best || folder.path.length > best.path.length) {
        best = folder;
      }
    }
    if (best) {
      return best.typesRoot;
    }
    return state.typesRoot;
  }

  return {
    /**
     * @param {import("typescript").server.PluginCreateInfo} info
     */
    create(info) {
      const project = info.project;
      install(project);
      const config = info.config;
      if (config && (config.enabled || config.typesRoot || (Array.isArray(config.folders) && config.folders.length > 0))) {
        state = normalizeState(config);
      }
      logger(project).info(
        supportsTypeScript(ts)
          ? `[node-runtime-types] plugin loaded (enabled=${state.enabled})`
          : `[node-runtime-types] TypeScript ${ts.version} is unchanged; only versions before 7 are supported`,
      );
      return info.languageService;
    },
    /**
     * @param {PluginState | undefined} config
     */
    onConfigurationChanged(config) {
      state = normalizeState(config);
      for (const project of projects) {
        project.__nodeRuntimeTypesBase = undefined;
        project.__nodeRuntimeTypesHas = undefined;
        project.__nodeRuntimeTypesList = undefined;
        project.__nodeRuntimeTypesRoot = undefined;
        project.__nodeRuntimeTypesGeneration = undefined;
        project.__nodeRuntimeTypesValue = undefined;
        project.__nodeRuntimeTypesLookup = undefined;
        project.__nodeRuntimeTypesDecision = undefined;
        try {
          project.resolutionCache?.clear?.();
        } catch (error) {
          logger(project).info(`[node-runtime-types] failed to clear resolution cache: ${error}`);
        }
        try {
          project.markAsDirty?.();
        } catch (error) {
          logger(project).info(`[node-runtime-types] failed to mark project dirty: ${error}`);
        }
        try {
          project.refreshDiagnostics?.();
        } catch (error) {
          logger(project).info(`[node-runtime-types] failed to refresh diagnostics: ${error}`);
        }
        logger(project).info(
          `[node-runtime-types] configuration updated (enabled=${state.enabled}, folders=${state.folders.length})`,
        );
      }
    },
  };
}

/**
 * @param {typeof import("typescript")} ts
 * @param {ProjectLike} project
 * @param {import("typescript").CompilerOptions} base
 * @param {string} typesRoot
 */
function lookupNodeTypes(ts, project, base) {
  const now = Date.now();
  const lookup = project.__nodeRuntimeTypesLookup;
  if (lookup && lookup.base === base && now - lookup.at < 1000) {
    return lookup.value;
  }
  const value = projectHasNodeTypes(ts, project, base);
  project.__nodeRuntimeTypesLookup = { at: now, base, value };
  return value;
}

/**
 * TypeScript 6 only loads @types packages named in `compilerOptions.types`,
 * or every package under the type roots when that list contains "*".
 * An omitted `types` field no longer includes `@types/node`.
 * TypeScript 7 is outside the supported range and is left unchanged.
 * @param {typeof import("typescript")} ts
 * @param {import("typescript").CompilerOptions} options
 */
function typescriptMajor(ts) {
  const major = Number(String(ts.version).split(".")[0]);
  return Number.isInteger(major) ? major : 0;
}

/** Type stripping support in this extension stops before TypeScript 7. */
function supportsTypeScript(ts) {
  const major = typescriptMajor(ts);
  return major > 0 && major < 7;
}

function needsNodeInTypesList(ts, options) {
  if (!supportsTypeScript(ts)) {
    return false;
  }
  if (Array.isArray(options.types) && (options.types.includes("node") || options.types.includes("*"))) {
    return false;
  }
  if (typescriptMajor(ts) === 6) {
    return true;
  }
  return Array.isArray(options.types);
}

/**
 * @param {typeof import("typescript")} ts
 * @param {ProjectLike} project
 * @param {import("typescript").CompilerOptions} base
 * @param {string} typesRoot
 * @param {boolean} hasNodeTypes
 * @param {boolean} listNode
 */
function deriveOptions(ts, project, base, typesRoot, hasNodeTypes, listNode) {
  if (hasNodeTypes && !listNode) {
    return base;
  }
  /** @type {import("typescript").CompilerOptions} */
  const next = { ...base };
  if (listNode) {
    next.types = [...(Array.isArray(base.types) ? base.types : []), "node"];
  }
  if (!hasNodeTypes && typesRoot) {
    const normalizedRoot = path.normalize(typesRoot);
    const existing = base.typeRoots
      ? base.typeRoots.map((root) => path.normalize(root))
      : defaultTypeRoots(ts, project);
    next.typeRoots = dedupePaths([...existing, normalizedRoot]);
  }
  return next;
}

/**
 * @param {typeof import("typescript")} ts
 * @param {ProjectLike} project
 */
function defaultTypeRoots(ts, project) {
  if (typeof ts.getDefaultTypeRoots !== "function") {
    return [];
  }
  const defaults = ts.getDefaultTypeRoots(project.getCurrentDirectory(), {
    directoryExists: (directory) => directoryExists(project, directory),
  });
  return defaults ? defaults.map((root) => path.normalize(root)) : [];
}

/**
 * @param {typeof import("typescript")} ts
 * @param {ProjectLike} project
 * @param {import("typescript").CompilerOptions} options
 */
function projectHasNodeTypes(ts, project, options) {
  try {
    const probe = path.join(project.getCurrentDirectory(), "__node_runtime_types_probe.ts");
    const result = ts.resolveTypeReferenceDirective(
      "node",
      probe,
      options,
      {
        fileExists: (file) => fileExists(project, file),
        readFile: (file) => readFile(project, file),
        directoryExists: (directory) => directoryExists(project, directory),
        getCurrentDirectory: () => project.getCurrentDirectory(),
      },
    );
    return Boolean(result.resolvedTypeReferenceDirective?.resolvedFileName);
  } catch (error) {
    logger(project).info(`[node-runtime-types] type lookup failed: ${error}`);
    return true;
  }
}

/**
 * @param {ProjectLike} project
 * @param {string} file
 */
function fileExists(project, file) {
  if (typeof project.fileExists === "function") {
    return project.fileExists(file);
  }
  return fs.existsSync(file);
}

/**
 * @param {ProjectLike} project
 * @param {string} file
 */
function readFile(project, file) {
  if (typeof project.readFile === "function") {
    return project.readFile(file);
  }
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * @param {ProjectLike} project
 * @param {string} directory
 */
function directoryExists(project, directory) {
  if (typeof project.directoryExists === "function") {
    return project.directoryExists(directory);
  }
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {PluginState | undefined} config
 * @returns {PluginState}
 */
function normalizeState(config) {
  const source = config && typeof config === "object" ? config : {};
  const folders = Array.isArray(source.folders)
    ? source.folders
        .filter((folder) => folder && typeof folder.path === "string" && typeof folder.typesRoot === "string")
        .map((folder) => ({
          path: stripTrailingSep(path.normalize(folder.path)),
          typesRoot: path.normalize(folder.typesRoot),
        }))
    : [];
  return {
    enabled: Boolean(source.enabled),
    generation: Date.now(),
    typesRoot: typeof source.typesRoot === "string" ? path.normalize(source.typesRoot) : undefined,
    folders,
  };
}

/**
 * @param {string} parent
 * @param {string} child
 */
function isInside(parent, child) {
  const left = stripTrailingSep(path.normalize(parent));
  const right = stripTrailingSep(path.normalize(child));
  if (process.platform === "win32") {
    const prefix = left.toLowerCase();
    const candidate = right.toLowerCase();
    return candidate === prefix || candidate.startsWith(prefix + path.sep);
  }
  return right === left || right.startsWith(left + path.sep);
}

/**
 * @param {string} value
 */
function stripTrailingSep(value) {
  if (value.length <= 1) {
    return value;
  }
  if (value.endsWith(path.sep) || value.endsWith("/")) {
    return stripTrailingSep(value.slice(0, -1));
  }
  return value;
}

/**
 * @param {string} left
 * @param {string} right
 */
function samePath(left, right) {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * @param {string[]} paths
 */
function dedupePaths(paths) {
  /** @type {string[]} */
  const unique = [];
  for (const entry of paths) {
    if (!unique.some((existing) => samePath(existing, entry))) {
      unique.push(entry);
    }
  }
  return unique;
}

/**
 * @param {ProjectLike} project
 */
function logger(project) {
  const info = project.projectService?.logger?.info?.bind(project.projectService.logger);
  return {
    info(message) {
      if (info) {
        info(message);
      }
    },
  };
}

module.exports = init;

/**
 * @typedef {Object} FolderConfig
 * @property {string} path
 * @property {string} typesRoot
 */

/**
 * @typedef {Object} PluginState
 * @property {boolean} enabled
 * @property {number} generation
 * @property {string} [typesRoot]
 * @property {FolderConfig[]} folders
 */

/**
 * @typedef {Object} ProjectLike
 * @property {() => import("typescript").CompilerOptions} getCompilationSettings
 * @property {() => import("typescript").CompilerOptions} [getCompilerOptions]
 * @property {() => string} getCurrentDirectory
 * @property {(file: string) => boolean} [fileExists]
 * @property {(file: string) => string | undefined} [readFile]
 * @property {(directory: string) => boolean} [directoryExists]
 * @property {{ clear?: () => void }} [resolutionCache]
 * @property {() => void} [markAsDirty]
 * @property {() => void} [refreshDiagnostics]
 * @property {{ logger?: { info?: (message: string) => void } }} [projectService]
 * @property {boolean} [__nodeRuntimeTypesWrapped]
 * @property {() => import("typescript").CompilerOptions} [__nodeRuntimeTypesOriginal]
 * @property {import("typescript").CompilerOptions} [__nodeRuntimeTypesBase]
 * @property {boolean} [__nodeRuntimeTypesHas]
 * @property {boolean} [__nodeRuntimeTypesList]
 * @property {string} [__nodeRuntimeTypesRoot]
 * @property {number} [__nodeRuntimeTypesGeneration]
 * @property {string} [__nodeRuntimeTypesDecision]
 * @property {import("typescript").CompilerOptions} [__nodeRuntimeTypesValue]
 * @property {{ at: number, base: import("typescript").CompilerOptions, value: boolean }} [__nodeRuntimeTypesLookup]
 */
