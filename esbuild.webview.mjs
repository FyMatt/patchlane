import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const watch = process.argv.includes("--watch");
const rootDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const shared = {
  entryPoints: ["././src/webview/main.tsx"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  outfile: "./media/webview/main.js",
  sourcemap: true,
  jsx: "automatic",
  logLevel: "info",
  plugins: [resolveImportsPlugin()]
};

if (watch) {
  const context = await esbuild.context(shared);
  await context.watch();
  console.log("Watching webview bundle...");
} else {
  await esbuild.build(shared);
}

function resolveImportsPlugin() {
  return {
    name: "resolve-imports",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path.startsWith("data:") || args.path.startsWith("http:") || args.path.startsWith("https:")) {
          return { external: true };
        }

        if (args.path.startsWith("node:")) {
          return { external: true };
        }

        const resolved = resolveSpecifier(args.path, args.resolveDir);
        if (!resolved) {
          return undefined;
        }

        return { path: resolved };
      });
    }
  };
}

function resolveSpecifier(specifier, resolveDir) {
  if (specifier.startsWith("#")) {
    return resolvePackageImport(specifier, resolveDir);
  }

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const absolute = path.isAbsolute(specifier) ? specifier : path.resolve(resolveDir, specifier);
    return resolveFileOrDirectory(absolute);
  }

  try {
    return require.resolve(specifier, { paths: [rootDir] });
  } catch {
    return undefined;
  }
}

function resolvePackageImport(specifier, resolveDir) {
  const packageJsonPath = findPackageJson(resolveDir);
  if (!packageJsonPath) {
    return undefined;
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const imported = packageJson.imports?.[specifier];
    const target = pickPackageImportTarget(imported);
    if (!target || !target.startsWith(".")) {
      return undefined;
    }

    return resolveFileOrDirectory(path.resolve(path.dirname(packageJsonPath), target));
  } catch {
    return undefined;
  }
}

function pickPackageImportTarget(imported) {
  if (typeof imported === "string") {
    return imported;
  }
  if (!imported || typeof imported !== "object") {
    return undefined;
  }

  return imported.browser ?? imported.default ?? imported.import ?? imported.module ?? imported.node;
}

function findPackageJson(startDir) {
  let current = startDir;
  while (current && current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, "package.json");
    if (isFile(packageJsonPath)) {
      return packageJsonPath;
    }
    current = path.dirname(current);
  }

  return undefined;
}

function resolveFileOrDirectory(candidate) {
  const fileCandidates = candidate.includes(".")
    ? [candidate]
    : [
        candidate,
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}.mts`,
        `${candidate}.cts`,
        `${candidate}.js`,
        `${candidate}.jsx`,
        `${candidate}.mjs`,
        `${candidate}.cjs`
      ];

  for (const file of fileCandidates) {
    if (isFile(file)) {
      return file;
    }
  }

  if (isDirectory(candidate)) {
    const indexCandidates = [
      path.join(candidate, "index.ts"),
      path.join(candidate, "index.tsx"),
      path.join(candidate, "index.mts"),
      path.join(candidate, "index.cts"),
      path.join(candidate, "index.js"),
      path.join(candidate, "index.jsx"),
      path.join(candidate, "index.mjs"),
      path.join(candidate, "index.cjs")
    ];

    for (const file of indexCandidates) {
      if (isFile(file)) {
        return file;
      }
    }
  }

  return undefined;
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
