/**
 * The package's JavaScript build: `bun scripts/build.ts <outdir>` (declarations come from tsc, see package.json).
 *
 * One bundle, src/index.ts, and the "./validate" subpath as a file that re-exports its names from that bundle. A
 * two-entry `bun build` (Bun 1.3.14) emits entries Node cannot load ("Export 'blockRows2' is not defined", review 6);
 * the root bundle alone loads, and a subpath that re-exports from it gives a consumer the very same functions. The
 * names come from the source module, so the subpath cannot drift from validate.ts.
 */
const out = process.argv[2] ?? "dist";
const src = new URL("../src/", import.meta.url).pathname;

const built = await Bun.build({ entrypoints: [`${src}index.ts`], outdir: out, target: "node", format: "esm", external: ["zod"] });
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
const names = Object.keys(await import(`${src}display/validate.ts`)).sort();
await Bun.write(
  `${out}/display/validate.js`,
  `// The "@mlpal/harness-protocol/validate" subpath: the root bundle's validation functions (scripts/build.ts).\nexport { ${names.join(", ")} } from "../index.js";\n`,
);
