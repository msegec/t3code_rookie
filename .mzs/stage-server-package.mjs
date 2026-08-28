import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [rootArgument, outputArgument, version] = process.argv.slice(2);
if (!rootArgument || !outputArgument || !version) {
  throw new Error("Usage: stage-server-package.mjs <repo-root> <output-dir> <version>");
}

const root = NodePath.resolve(rootArgument);
const output = NodePath.resolve(outputArgument);
const serverDirectory = NodePath.join(root, "apps/server");
const requireFromServer = NodeModule.createRequire(NodePath.join(serverDirectory, "package.json"));
const { parse } = requireFromServer("yaml");
const { resolveCatalogDependencies } = await import(
  NodeURL.pathToFileURL(NodePath.join(root, "scripts/lib/resolve-catalog.ts")).href
);
const { resolveWebAssetBrandForPackageVersion, resolveWebIconOverrides } = await import(
  NodeURL.pathToFileURL(NodePath.join(root, "scripts/lib/brand-assets.ts")).href
);

const serverPackage = JSON.parse(
  await NodeFSP.readFile(NodePath.join(serverDirectory, "package.json"), "utf8"),
);
const workspace = parse(await NodeFSP.readFile(NodePath.join(root, "pnpm-workspace.yaml"), "utf8"));
const catalog = workspace.catalog ?? {};

const packageManifest = {
  name: serverPackage.name,
  repository: serverPackage.repository,
  bin: serverPackage.bin,
  type: serverPackage.type,
  version,
  engines: serverPackage.engines,
  files: serverPackage.files,
  dependencies: resolveCatalogDependencies(serverPackage.dependencies, catalog, "apps/server"),
  overrides: resolveCatalogDependencies(workspace.overrides ?? {}, catalog, "apps/server"),
};

await NodeFSP.mkdir(output, { recursive: false });
await NodeFSP.cp(NodePath.join(serverDirectory, "dist"), NodePath.join(output, "dist"), {
  recursive: true,
});
await NodeFSP.writeFile(
  NodePath.join(output, "package.json"),
  `${JSON.stringify(packageManifest, null, 2)}\n`,
);

const brand = resolveWebAssetBrandForPackageVersion(version);
for (const icon of resolveWebIconOverrides(brand, "dist/client")) {
  await NodeFSP.copyFile(
    NodePath.join(root, icon.sourceRelativePath),
    NodePath.join(output, icon.targetRelativePath),
  );
}
