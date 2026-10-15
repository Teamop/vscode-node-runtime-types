# Node Runtime Types

Typecheck and run TypeScript files with the Node.js installed on your machine.

Node.js 24.12+ can run a `.ts` file directly. This extension installs the matching `@types/node` and gives it to the editor, so imports such as `node:fs` and `node:path` typecheck even when the project does not depend on `@types/node`. The same runtime launches and debugs the active file.

## Possible Scenarios

- A quick TypeScript playground: write a `.ts` file that imports Node.js built-ins, use VS Code IntelliSense, and run that file. No need a project `node_modules` and `tsconfig.json`.

## Features

- Detects `node` on `PATH`, or a Node.js executable you set for the workspace
- Installs `@types/node` for that runtime and supplies it to TypeScript
- Uses the project's `node_modules/@types/node` when that package is already installed
- Runs and debugs the active TypeScript file with that runtime
- Shows the detected runtime in the status bar

## Requirements

- Node.js 24.12 or newer
- TypeScript < 7

Older Node.js is ignored. The extension does not install type definitions for it, and it does not write a `tsconfig.json`.

## Commands

Open a TypeScript file, then run a command from the Command Palette:

- **Node Runtime Types: Run Current TypeScript File**
- **Node Runtime Types: Debug Current TypeScript File**
- **Node Runtime Types: Refresh Runtime Types**
- **Node Runtime Types: Show Runtime Status**

A play button appears in the editor title when the runtime is supported. Click the status bar item to see which Node.js and which `@types/node` are in use.

## Settings

| Setting | Description |
| --- | --- |
| `nodeRuntimeTypes.nodePath` | Absolute path to the Node.js executable for this workspace folder. Leave empty to use `node` on `PATH`. |

With a folder open, the extension looks for `node_modules/@types/node` in that folder and in parent directories. A file opened without a folder is checked from that file's directory upward. When the package is found, it is used. When its major version differs from the runtime, it stays in place and the status bar marks the difference.

## Development

Build, run, and test instructions are in [DEVELOPMENT.md](DEVELOPMENT.md).
