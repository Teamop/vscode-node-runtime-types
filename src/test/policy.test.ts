import assert from "node:assert/strict";
import test from "node:test";
import { formatRunCommand, isSupportedNodeVersion, parseNodeVersion, selectTypesMajor } from "../policy";
import { typesLookupDirectory } from "../projectTypes";
import { quoteCmdArg } from "../runtime";
import { runtimeTypesPlan } from "../runtimeTypesPlan";
import { enqueue } from "../queue";
import { parseVersionList } from "../typesInstaller";

test("parseNodeVersion reads the runtime banner", () => {
  assert.deepEqual(parseNodeVersion("v24.11.1"), { major: 24, minor: 11, patch: 1, version: "24.11.1" });
  assert.equal(parseNodeVersion("not-a-version"), undefined);
});

test("only Node 24.12 and newer receive type definitions", () => {
  assert.equal(isSupportedNodeVersion({ major: 24, minor: 11, patch: 9 }), false);
  assert.equal(isSupportedNodeVersion({ major: 24, minor: 12, patch: 0 }), true);
  assert.equal(isSupportedNodeVersion({ major: 25, minor: 0, patch: 0 }), true);
  assert.equal(selectTypesMajor(22, [22, 24]), undefined);
  assert.equal(selectTypesMajor(24, [22, 24, 25]), 24);
  assert.equal(selectTypesMajor(27, [24, 25, 26]), 26);
});

test("a project that already has @types/node does not receive a cache download", () => {
  const plan = runtimeTypesPlan([
    { path: "C:\\work\\app", supported: true, projectTypesVersion: "24.19.2" },
    { path: "C:\\work\\other", supported: true, typesRoot: "C:\\cache\\node_modules\\@types" },
  ]);
  assert.equal(plan.enabled, true);
  assert.deepEqual(plan.folders, [{ path: "C:\\work\\other", typesRoot: "C:\\cache\\node_modules\\@types" }]);
  const onlyProjectTypes = runtimeTypesPlan([
    { path: "C:\\work\\app", supported: true, projectTypesVersion: "24.19.2" },
  ]);
  assert.equal(onlyProjectTypes.enabled, true);
  assert.deepEqual(onlyProjectTypes.folders, []);
});

test("one cache directory installs at a time, and a failure releases the queue", async () => {
  let active = 0;
  let maxActive = 0;
  const key = `install-${Date.now()}`;
  const task = () =>
    enqueue(key, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    });
  await Promise.all([task(), task(), task()]);
  assert.equal(maxActive, 1);

  const other = `${key}-other`;
  let together = 0;
  let maxTogether = 0;
  const parallel = (id: string) =>
    enqueue(id, async () => {
      together += 1;
      maxTogether = Math.max(maxTogether, together);
      await new Promise((resolve) => setTimeout(resolve, 20));
      together -= 1;
    });
  await Promise.all([parallel(key), parallel(other)]);
  assert.equal(maxTogether, 2);

  await assert.rejects(enqueue(`${key}-fail`, async () => {
    throw new Error("install failed");
  }));
  assert.equal(await enqueue(`${key}-fail`, async () => "next"), "next");
});

test("type lookup starts at the workspace folder, or at a loose file", () => {
  assert.equal(typesLookupDirectory("C:\\work\\app", "C:\\work\\app\\pkg\\main.ts"), "C:\\work\\app");
  assert.equal(typesLookupDirectory(undefined, "C:\\work\\app\\src\\main.ts"), "C:\\work\\app\\src");
  assert.equal(typesLookupDirectory(undefined, undefined), undefined);
});

test("parseVersionList accepts npm json output", () => {
  const versions = parseVersionList('npm warn extra\n["24.0.0","25.1.0"]\n');
  assert.deepEqual(versions, ["24.0.0", "25.1.0"]);
});

test("formatRunCommand quotes paths for PowerShell and cmd", () => {
  assert.equal(
    formatRunCommand("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "C:\\Program Files\\nodejs\\node.exe", "C:\\work\\app.ts"),
    "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\work\\app.ts'",
  );
  assert.equal(
    formatRunCommand("C:\\Windows\\System32\\cmd.exe", "C:\\node.exe", "C:\\work\\it's.ts"),
    '"C:\\node.exe" "C:\\work\\it\'s.ts"',
  );
  assert.equal(quoteCmdArg("C:\\Program Files\\node.exe"), '"C:\\Program Files\\node.exe"');
});
