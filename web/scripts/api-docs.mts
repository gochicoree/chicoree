// Writes ../API.md from the endpoint catalog (lib/api/docs.ts), or with
// --check verifies that the file is current and that every route handler
// under src/app/api/v1 has a catalog entry and vice versa.
//
//   npm run api:docs          # regenerate API.md
//   npm run api:check         # fail when API.md is stale or a route is undocumented
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { API_CATALOG, routeDirectory } from "../src/lib/api/catalog";
import { apiDocsMarkdown } from "../src/lib/api/docs";
import { openApiDocument } from "../src/lib/api/openapi";

const root = resolve(import.meta.dirname, "..");
const routesDir = join(root, "src/app/api/v1");
const target = join(root, "..", "API.md");
const check = process.argv.includes("--check");

/** Every `<method> <catalog path>` a route file exports. */
function scanRoutes(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") {
        const rel = relative(routesDir, dir);
        if (rel.startsWith("[...")) continue; // the JSON 404 catch-all
        const path = rel ? `/${rel.split(/[\\/]/).map((s) => s.replace(/^\[(\w+)\]$/, "{$1}")).join("/")}` : "/";
        const src = readFileSync(full, "utf8");
        for (const m of src.matchAll(/^export (?:const|async function) (GET|POST|PUT|PATCH|DELETE)\b/gm)) found.add(`${m[1]} ${path}`);
      }
    }
  };
  walk(routesDir);
  return found;
}

const problems: string[] = [];
const routes = scanRoutes();
const documented = new Set(API_CATALOG.map((e) => `${e.method} ${e.path}`));
for (const r of routes) if (!documented.has(r)) problems.push(`route without a catalog entry: ${r}`);
for (const d of documented) if (!routes.has(d)) problems.push(`catalog entry without a route: ${d} (expected src/app/api/v1/${routeDirectory(API_CATALOG.find((e) => `${e.method} ${e.path}` === d)!.path)}/route.ts)`);

// The OpenAPI document must be valid for the tools that consume it.
try {
  await SwaggerParser.validate(structuredClone(openApiDocument({ appUrl: "https://registry.example.com" })) as never);
} catch (err) {
  problems.push(`OpenAPI document invalid: ${err instanceof Error ? err.message : String(err)}`);
}

const markdown = apiDocsMarkdown({ appUrl: "https://registry.example.com", registryHost: "registry.example.com" });
if (check) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    problems.push("API.md is missing");
  }
  if (current && current !== markdown) problems.push("API.md is stale — run `npm run api:docs` in web/");
} else {
  writeFileSync(target, markdown);
  console.log(`wrote ${relative(process.cwd(), target)} (${API_CATALOG.length} endpoints)`);
}

if (problems.length) {
  console.error("API documentation check failed:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
if (check) console.log(`API docs OK: ${API_CATALOG.length} endpoints documented, OpenAPI valid, API.md current`);
