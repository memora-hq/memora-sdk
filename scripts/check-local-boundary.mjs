#!/usr/bin/env node
// scripts/check-local-boundary.mjs
//
// This repo (memora-sdk) publishes portable, machine-agnostic packages: the protocol
// dependency, the offline verifier, the client SDK, and the CLI. None of it should ever
// depend on node-pty, Electron, or any machine-local capture code — that lives in the
// separate memora-local repo. See packages/verifier/README.md ("What's deliberately not
// here") and AGENTS.md for the rationale.
//
// Two independent checks, run against every workspace package by default:
//
//   Class A — static import scan. Flags any import/export-from/dynamic-import specifier
//   that is or starts with a forbidden bare specifier.
//
//   Class B — resolved dependency-tree scan. Shells out to `pnpm list --filter <pkg>
//   --prod --depth Infinity --json` and walks the resolved tree for a forbidden package
//   name. This is what actually proves "installing this package invokes no native
//   compilation" — a clean Class A scan alone can't rule out a transitive dependency
//   pulling node-pty in behind your back.
//
// Usage:
//   node scripts/check-local-boundary.mjs
//   Scans every package under packages/ and examples/ in this workspace.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_BARE_SPECIFIERS = ["node-pty", "electron", "@memora/local", "@memora-hq/memora-local"];
const FORBIDDEN_TRANSITIVE_NAMES = new Set(["node-pty", "electron"]);

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules", "dist", "build", "out", "coverage", ".turbo", ".git",
]);

const IMPORT_SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".cts", ".mts"]);
const FROM_CLAUSE_RE = /\bfrom\s*["']([^"']+)["']/g;
const SIDE_EFFECT_IMPORT_RE = /(?<!\w)import\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function walk(dirAbs) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

function isForbiddenSpecifier(spec) {
  return FORBIDDEN_BARE_SPECIFIERS.some((name) => spec === name || spec.startsWith(`${name}/`));
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === "\n") line++;
  return line;
}

function collectImportSpecifiers(content) {
  const found = [];
  for (const re of [FROM_CLAUSE_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(content))) found.push({ specifier: match[1], index: match.index });
  }
  return found;
}

function findPackageDirs() {
  const dirs = [];
  for (const group of ["packages", "examples"]) {
    const groupAbs = path.join(REPO_ROOT, group);
    let entries;
    try {
      entries = fs.readdirSync(groupAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgJsonPath = path.join(groupAbs, entry.name, "package.json");
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        dirs.push({ name: pkg.name, root: path.join(groupAbs, entry.name) });
      }
    }
  }
  return dirs;
}

function scanSourceTree(pkgRootAbs) {
  const violations = [];
  const srcDir = path.join(pkgRootAbs, "src");
  const scanRoot = fs.existsSync(srcDir) ? srcDir : pkgRootAbs;
  for (const fileAbs of walk(scanRoot)) {
    if (!IMPORT_SCAN_EXTENSIONS.has(path.extname(fileAbs))) continue;
    const content = fs.readFileSync(fileAbs, "utf8");
    for (const { specifier, index } of collectImportSpecifiers(content)) {
      if (isForbiddenSpecifier(specifier)) {
        violations.push({ file: path.relative(REPO_ROOT, fileAbs), line: lineNumberAt(content, index), specifier });
      }
    }
  }
  return violations;
}

function scanResolvedDependencyTree(pkgName) {
  let json;
  try {
    const out = execFileSync(
      "pnpm",
      ["list", "--filter", pkgName, "--prod", "--depth", "Infinity", "--json"],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    json = JSON.parse(out);
  } catch (error) {
    return { error: `pnpm list failed: ${error.message}` };
  }
  const found = new Set();
  function walkDeps(deps) {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      if (FORBIDDEN_TRANSITIVE_NAMES.has(name)) found.add(name);
      if (info && typeof info === "object") walkDeps(info.dependencies);
    }
  }
  for (const project of json) walkDeps(project.dependencies);
  return { found: [...found] };
}

function main() {
  const packages = findPackageDirs();
  let violationCount = 0;

  for (const { name, root } of packages) {
    const sourceViolations = scanSourceTree(root);
    for (const v of sourceViolations) {
      violationCount++;
      console.error(`✗ [source import] ${v.file}:${v.line} imports forbidden "${v.specifier}"`);
    }

    const depResult = scanResolvedDependencyTree(name);
    if (depResult.error) {
      violationCount++;
      console.error(`✗ [dependency scan] ${name}: ${depResult.error}`);
    } else if (depResult.found.length > 0) {
      violationCount++;
      console.error(`✗ [dependency scan] ${name} transitively depends on: ${depResult.found.join(", ")}`);
    }

    if (sourceViolations.length === 0 && !depResult.error && (depResult.found?.length ?? 0) === 0) {
      console.log(`✓ ${name}: no forbidden imports, no node-pty/electron in resolved prod dependency tree`);
    }
  }

  if (violationCount > 0) {
    console.error(`\nlocal boundary guard: ${violationCount} violation(s)`);
    process.exit(1);
  }
  console.log(`\nlocal boundary guard: 0 violations`);
}

main();
