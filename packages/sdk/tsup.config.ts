import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/opentelemetry.ts"],
  format: ["esm"],
  tsconfig: "tsconfig.release.json",
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  bundle: true,
  // @memora-hq/memora-protocol must stay external, not bundled. Its dist is CommonJS
  // and calls require("crypto") internally; esbuild inlines that as a lazy CJS shim
  // that resolves `require` via `typeof require !== "undefined"`. That check comes up
  // empty when this file is loaded as real ESM (e.g. `node dist/cli.js` in @memora/cli,
  // whose package.json has "type": "module"), so it throws "Dynamic require of
  // \"crypto\" is not supported" the moment this module evaluates — before any command
  // dispatch, since the import happens at the top of the file. Marking it external
  // instead leaves it as a plain `import`, which Node's own CJS-from-ESM interop
  // resolves correctly at runtime — no bundler shim involved.
  external: ["@opentelemetry/api", "@opentelemetry/sdk-trace-base", "@memora-hq/memora-protocol"],
  platform: "node",
  target: "es2020",
  outDir: "dist",
});
