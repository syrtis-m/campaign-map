// Playground dev server: esbuild watch + serve (no new dependencies).
// `npm run playground` → http://localhost:8734
import esbuild from "esbuild";

const ctx = await esbuild.context({
  entryPoints: ["playground/main.ts"],
  bundle: true,
  format: "iife",
  outfile: "playground/dist/main.js",
  sourcemap: "inline",
  logLevel: "info",
});

await ctx.watch();
const { hosts, port } = await ctx.serve({ servedir: "playground", port: 8734 });
const host = hosts?.[0] === "0.0.0.0" || !hosts?.[0] ? "localhost" : hosts[0];
console.log(`procgen playground → http://${host}:${port}/`);
