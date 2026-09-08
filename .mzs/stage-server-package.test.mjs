import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

NodeTest.test("stages an npm-installable package from pnpm workspace overrides", (test) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-package-test-"));
  test.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const root = NodePath.join(directory, "source");
  const output = NodePath.join(directory, "package");
  const installed = NodePath.join(directory, "installed");
  const dependency = NodePath.join(directory, "dependency");
  NodeFS.mkdirSync(NodePath.join(root, "apps/server/dist/client"), { recursive: true });
  NodeFS.mkdirSync(dependency);
  NodeFS.writeFileSync(
    NodePath.join(dependency, "package.json"),
    JSON.stringify({ name: "runtime-dependency", version: "1.0.0" }),
  );
  for (const name of ["scripts", "node_modules", "assets"]) {
    NodeFS.symlinkSync(
      NodePath.resolve(import.meta.dirname, "..", name),
      NodePath.join(root, name),
    );
  }
  NodeFS.symlinkSync(
    NodePath.resolve(import.meta.dirname, "../apps/server/node_modules"),
    NodePath.join(root, "apps/server/node_modules"),
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "apps/server/package.json"),
    JSON.stringify({
      name: "t3-package-fixture",
      type: "module",
      bin: { t3: "./dist/bin.mjs" },
      files: ["dist"],
      dependencies: { "runtime-dependency": "catalog:" },
    }),
  );
  NodeFS.writeFileSync(NodePath.join(root, "apps/server/dist/bin.mjs"), "console.log('fixture');");
  NodeFS.writeFileSync(
    NodePath.join(root, "pnpm-workspace.yaml"),
    `catalog:\n  runtime-dependency: ${JSON.stringify(`file:${dependency}`)}\noverrides:\n  "dbus-next>usocket": "-"\n  "runtime-dependency": "catalog:"\n`,
  );
  const run = (command, args, cwd) => {
    const result = NodeChildProcess.spawnSync(command, args, { cwd, encoding: "utf8" });
    NodeAssert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
  };
  run(process.execPath, [
    NodePath.join(import.meta.dirname, "stage-server-package.mjs"),
    root,
    output,
    "1.0.0",
  ]);
  run("npm", ["pack", "--ignore-scripts", "--offline", "--pack-destination", directory], output);
  run(
    "npm",
    [
      "install",
      "--prefix",
      installed,
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      NodePath.join(directory, "t3-package-fixture-1.0.0.tgz"),
    ],
    directory,
  );
  const manifest = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(installed, "node_modules/t3-package-fixture/package.json"),
      "utf8",
    ),
  );
  NodeAssert.deepEqual(manifest.dependencies, { "runtime-dependency": `file:${dependency}` });
  NodeAssert.equal(Object.hasOwn(manifest, "overrides"), false);
  NodeAssert.equal(
    NodeFS.readFileSync(
      NodePath.join(installed, "node_modules/t3-package-fixture/dist/bin.mjs"),
      "utf8",
    ),
    "console.log('fixture');",
  );
});
