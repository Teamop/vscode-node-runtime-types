import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { formatRunCommand, isSupportedNodeVersion, MIN_NODE_LABEL, parseNodeVersion } from "./policy";
import { readProjectNodeTypesVersion, typesLookupDirectory } from "./projectTypes";
import { enqueue } from "./queue";
import { detectNodeRuntime, type NodeRuntime } from "./runtime";
import { runtimeTypesPlan } from "./runtimeTypesPlan";
import { ensureNodeTypes, type InstalledNodeTypes } from "./typesInstaller";

const pluginId = "node-runtime-types-plugin";

interface FolderState {
  folder?: vscode.WorkspaceFolder;
  runtime?: NodeRuntime;
  types?: InstalledNodeTypes;
  projectTypesVersion?: string;
  error?: string;
}

let channel: vscode.LogOutputChannel;
let statusBar: vscode.StatusBarItem;
let folderStates: FolderState[] = [];
let looseFileState: FolderState | undefined;
let looseTypesDirectory: string | undefined;
const warningsShown = new Set<string>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  channel = vscode.window.createOutputChannel("Node Runtime Types", { log: true });
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "nodeRuntimeTypes.showStatus";
  statusBar.show();

  context.subscriptions.push(
    channel,
    statusBar,
    vscode.commands.registerCommand("nodeRuntimeTypes.refresh", () => refresh(context, true)),
    vscode.commands.registerCommand("nodeRuntimeTypes.showStatus", () => showStatus()),
    vscode.commands.registerCommand("nodeRuntimeTypes.runFile", () => runFile(false)),
    vscode.commands.registerCommand("nodeRuntimeTypes.debugFile", () => runFile(true)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("nodeRuntimeTypes.nodePath")) {
        void refresh(context, false);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refresh(context, false);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updateStatusBar();
      if ((vscode.workspace.workspaceFolders ?? []).length > 0) {
        return;
      }
      const directory = typesLookupDirectory(undefined, activeFilePath());
      if (directory === looseTypesDirectory) {
        return;
      }
      void refresh(context, false);
    }),
  );

  await refresh(context, false);
}

export function deactivate(): void {
  return undefined;
}

function refresh(context: vscode.ExtensionContext, force: boolean): Promise<void> {
  return enqueue("node-runtime-types:refresh", () => runRefresh(context, force));
}

async function runRefresh(context: vscode.ExtensionContext, force: boolean): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Detecting Node.js runtime types" },
    async () => {
      const storage = context.globalStorageUri.fsPath;
      await mkdir(storage, { recursive: true });
      const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
      if (workspaceFolders.length === 0) {
        looseTypesDirectory = typesLookupDirectory(undefined, activeFilePath());
        looseFileState = await inspect(undefined, storage, force);
        folderStates = looseFileState ? [looseFileState] : [];
      } else {
        looseFileState = undefined;
        looseTypesDirectory = undefined;
        folderStates = await Promise.all(workspaceFolders.map((folder) => inspect(folder, storage, force)));
      }
      await configureTypeScript();
      updateStatusBar();
      for (const state of folderStates) {
        warnIfNeeded(state);
      }
    },
  );
}

async function inspect(folder: vscode.WorkspaceFolder | undefined, storage: string, force: boolean): Promise<FolderState> {
  const label = folder?.uri.fsPath ?? "open files";
  const nodePath = vscode.workspace.getConfiguration("nodeRuntimeTypes", folder).get<string>("nodePath")?.trim();
  let runtime: NodeRuntime | undefined;
  try {
    runtime = await detectNodeRuntime(nodePath, folder?.uri.fsPath);
    channel.info(`${label}: Node.js ${runtime.version} (${runtime.execPath})`);
    if (!isSupportedNodeVersion(runtime)) {
      return { folder, runtime, error: `Node.js ${runtime.version} is older than ${MIN_NODE_LABEL}.` };
    }
    const lookupDirectory = typesLookupDirectory(folder?.uri.fsPath, folder ? undefined : activeFilePath());
    if (!lookupDirectory) {
      channel.info(`${label}: waiting for a TypeScript file before installing runtime types`);
      return { folder, runtime };
    }
    const projectTypesVersion = readProjectNodeTypesVersion(lookupDirectory);
    if (projectTypesVersion) {
      channel.info(`${label}: using project @types/node@${projectTypesVersion}; not downloading runtime types`);
      return { folder, runtime, projectTypesVersion };
    }
    const types = await ensureNodeTypes(storage, runtime.major, runtime.execPath, force);
    channel.info(`${label}: @types/node@${types.typesVersion}`);
    return { folder, runtime, types, projectTypesVersion };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    channel.error(`${label}: ${message}`);
    return { folder, runtime, error: message };
  }
}

async function configureTypeScript(): Promise<void> {
  const config = runtimeTypesPlan(
    folderStates.map((state) => ({
      path: state.folder?.uri.fsPath,
      supported: Boolean(state.runtime && isSupportedNodeVersion(state.runtime)),
      projectTypesVersion: state.projectTypesVersion,
      typesRoot: state.types?.typesRoot,
    })),
    looseFileState?.types?.typesRoot,
  );
  const typescriptExtension = vscode.extensions.getExtension("vscode.typescript-language-features");
  if (!typescriptExtension) {
    channel.error("The built-in TypeScript extension is not available.");
    return;
  }
  if (!typescriptExtension.isActive) {
    await typescriptExtension.activate();
  }
  await vscode.commands.executeCommand("_typescript.configurePlugin", pluginId, config);
  channel.info(`Configured ${pluginId} (enabled=${config.enabled}, folders=${config.folders.length}).`);
}

function updateStatusBar(): void {
  const state = stateFor(vscode.window.activeTextEditor?.document.uri) ?? folderStates[0];
  const supported = Boolean(state?.runtime && isSupportedNodeVersion(state.runtime));
  void vscode.commands.executeCommand("setContext", "nodeRuntimeTypes.supported", supported);
  if (!state) {
    statusBar.text = "$(pulse) Node types";
    statusBar.tooltip = "Node Runtime Types is waiting for a workspace.";
    statusBar.backgroundColor = undefined;
    return;
  }
  if (!state.runtime) {
    statusBar.text = "$(error) Node types";
    statusBar.tooltip = state.error ?? "Node.js was not detected.";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    return;
  }
  if (!isSupportedNodeVersion(state.runtime)) {
    statusBar.text = `$(circle-slash) Node ${state.runtime.version}`;
    statusBar.tooltip = `Node.js ${MIN_NODE_LABEL} or newer is required. This runtime is ${state.runtime.version}.`;
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    return;
  }
  const projectMajor = state.projectTypesVersion ? parseNodeVersion(state.projectTypesVersion)?.major : undefined;
  const mismatch = projectMajor !== undefined && projectMajor !== state.runtime.major;
  if (state.projectTypesVersion) {
    statusBar.text = `$(versions) Node ${state.runtime.version}`;
    statusBar.tooltip = mismatch
      ? `This folder uses @types/node@${state.projectTypesVersion}, which does not match Node.js ${state.runtime.version}. The project package is left in place.`
      : `Using the project's @types/node@${state.projectTypesVersion}.`;
  } else if (!state.types && !state.error) {
    statusBar.text = `$(versions) Node ${state.runtime.version}`;
    statusBar.tooltip = "Open a TypeScript file to install Node.js type definitions.";
    statusBar.backgroundColor = undefined;
    return;
  } else if (state.types) {
    statusBar.text = `$(versions) Node ${state.runtime.version}`;
    statusBar.tooltip =
      state.types.typesMajor === state.runtime.major
        ? `Using @types/node@${state.types.typesVersion} for Node.js ${state.runtime.version}.`
        : `Exact types for Node.js ${state.runtime.major} are not published. Using @types/node@${state.types.typesVersion}.`;
  } else {
    statusBar.text = `$(error) Node ${state.runtime.version}`;
    statusBar.tooltip = state.error ?? "Type definitions could not be installed.";
  }
  statusBar.backgroundColor = mismatch || state.error ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
}

function warnIfNeeded(state: FolderState): void {
  const key = `${state.folder?.uri.fsPath ?? "loose"}:${state.runtime?.execPath ?? state.error ?? ""}`;
  if (warningsShown.has(key)) {
    return;
  }
  if (state.runtime && !isSupportedNodeVersion(state.runtime)) {
    return;
  }
  if (state.error && !state.types) {
    warningsShown.add(key);
    void vscode.window.showErrorMessage(`Node Runtime Types could not provide Node.js types. ${state.error}`);
  }
}

function showStatus(): void {
  const state = stateFor(vscode.window.activeTextEditor?.document.uri) ?? folderStates[0];
  if (!state) {
    void vscode.window.showInformationMessage("Open a folder or TypeScript file to detect the Node.js runtime.");
    return;
  }
  const lines = [
    state.runtime ? `Runtime: Node.js ${state.runtime.version} (${state.runtime.execPath})` : "Runtime: not detected",
    state.projectTypesVersion
      ? `Project types: @types/node@${state.projectTypesVersion}`
      : state.types
        ? `Runtime types: @types/node@${state.types.typesVersion}`
        : "Runtime types: not installed",
  ];
  if (state.error) {
    lines.push(state.error);
  }
  void vscode.window.showInformationMessage(lines.join("\n"));
}

async function runFile(debug: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "typescript") {
    void vscode.window.showWarningMessage("Open a TypeScript file to run it with Node.js.");
    return;
  }
  const state = stateFor(editor.document.uri);
  if (!state?.runtime || !isSupportedNodeVersion(state.runtime)) {
    void vscode.window.showWarningMessage(
      `Running TypeScript requires Node.js ${MIN_NODE_LABEL} or newer. Set nodeRuntimeTypes.nodePath to that runtime.`,
    );
    return;
  }
  const file = editor.document.uri.fsPath;
  const cwd = state.folder?.uri.fsPath ?? path.dirname(file);
  if (debug) {
    await vscode.debug.startDebugging(state.folder, {
      type: "node",
      request: "launch",
      name: "Debug TypeScript with Node",
      program: file,
      cwd,
      runtimeExecutable: state.runtime.execPath,
      skipFiles: ["<node_internals>/**"],
      console: "integratedTerminal",
    });
    return;
  }
  const terminal = vscode.window.createTerminal({ name: "Node TypeScript", cwd });
  terminal.show();
  terminal.sendText(formatRunCommand(vscode.env.shell, state.runtime.execPath, file));
}

function activeFilePath(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === "file" ? uri.fsPath : undefined;
}

function stateFor(uri: vscode.Uri | undefined): FolderState | undefined {
  if (!uri) {
    return looseFileState ?? folderStates[0];
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return looseFileState ?? folderStates[0];
  }
  return folderStates.find((state) => state.folder === folder) ?? folderStates[0];
}
