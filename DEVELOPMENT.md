# Development

## Run the extension

1. Install dependencies and compile:

   ```bash
   npm install
   npm run compile
   ```

2. Press **F5** and choose **Run Extension**.
3. In the Extension Development Host, open a folder whose Node.js is 24.12 or newer and that does not already install `@types/node`.
4. Open a TypeScript file that imports a Node.js built-in. The status bar shows the detected runtime, and the import should have no TypeScript error.
5. Run **Node Runtime Types: Run Current TypeScript File** or **Debug Current TypeScript File**.
6. **Refresh Runtime Types** detects the runtime again. **Show Runtime Status** reports the runtime and which `@types/node` is in use. If the project's package major differs from the runtime, that package stays in place and the status bar marks the difference.

## Tests

```bash
npm test
```

## Behavior

The extension installs `@types/node` for the runtime major version. If that major is not published yet, it installs the newest published major that is at least 24 and not newer than the runtime.

It looks for `node_modules/@types/node` in the opened folder and in parent directories. A file opened without a folder is checked from that file's directory upward. When the package is found, the extension uses it and does not download another copy. The download check does not look inside nested packages. The language service still keeps `@types/node` when the TypeScript project already resolves it.

TypeScript 7 is left unchanged. The TypeScript server log notes that, and there is no editor warning. On TypeScript 6, an omitted `compilerOptions.types` list does not load `@types` packages, so the extension adds `node` to the language service's in-memory type list when `node` or `*` is not already there. TypeScript 5 gets that same addition only when `types` is already a list that omits `node`. No `tsconfig.json` or other project file is written.
