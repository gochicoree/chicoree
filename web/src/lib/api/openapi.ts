// An OpenAPI 3.1 document derived from the endpoint catalog, served at
// GET /api/v1/openapi.json for Swagger UI, Postman, Insomnia and client
// generators. Response schemas are inferred from the catalog's examples, so
// they describe the shape, not every constraint. Pure: no Node imports.
import { ACCESS_LABELS, API_CATALOG, API_GROUPS, type ApiEndpoint, type ApiParam } from "./catalog";
import { API_BASE, API_CHANGELOG, API_NOTICE, API_REVISION } from "./version";

type Schema = Record<string, unknown>;

/** "public | private" → enum; integer / boolean / date / string → the JSON Schema type. */
function schemaFor(type: string): Schema {
  if (type.includes("|")) return { type: "string", enum: type.split("|").map((s) => s.trim()) };
  switch (type) {
    case "integer":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
    default:
      return { type: "string" };
  }
}

/** A loose schema from an example value: shape only. */
export function inferSchema(value: unknown): Schema {
  if (value === null || value === undefined) return { description: "null in the example; see the documentation for the type." };
  if (Array.isArray(value)) return { type: "array", items: value.length ? inferSchema(value[0]) : {} };
  switch (typeof value) {
    case "string":
      return /^\d{4}-\d{2}-\d{2}T/.test(value) ? { type: "string", format: "date-time" } : { type: "string" };
    case "number":
      return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      const properties: Record<string, Schema> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) properties[k] = inferSchema(v);
      return { type: "object", properties };
    }
    default:
      return {};
  }
}

function operationId(e: ApiEndpoint): string {
  const words = e.path
    .replace(/\{(\w+)\}/g, "by-$1")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return e.method.toLowerCase() + (words.length ? words.join("") : "Index");
}

function parameter(p: ApiParam) {
  return {
    name: p.name,
    in: p.in,
    required: p.in === "path" ? true : !!p.required,
    description: p.description,
    schema: schemaFor(p.type),
  };
}

const ERROR_RESPONSES: Record<string, string> = {
  "400": "A parameter is malformed.",
  "401": "No usable credential.",
  "403": "The credential may not do this.",
  "404": "Not found, or not visible to the caller.",
  "409": "The registry's state refuses the change.",
  "422": "A value is not acceptable.",
};

function operation(e: ApiEndpoint) {
  const params = e.params ?? [];
  const body = params.filter((p) => p.in === "body");
  const description = [
    e.description,
    `**Who:** ${ACCESS_LABELS[e.access]}.`,
    e.write ? "Needs a read & write token." : null,
    e.serviceAccounts ? "Service accounts may call it." : "Service accounts cannot call it.",
    `Since revision ${e.since}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const responses: Record<string, unknown> = {
    [String(e.status ?? 200)]: {
      description: "Success",
      content: { "application/json": { schema: e.example === undefined ? {} : inferSchema(e.example), ...(e.example === undefined ? {} : { example: e.example }) } },
    },
  };
  const errors = ["401", "403", "404", ...(body.length || params.some((p) => p.in === "query") ? ["400", "422"] : []), ...(e.method === "DELETE" || e.method === "POST" ? ["409"] : [])];
  for (const code of [...new Set(errors)].sort()) {
    responses[code] = { description: ERROR_RESPONSES[code], content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
  }
  return {
    operationId: operationId(e),
    tags: [e.group],
    summary: e.summary,
    description,
    parameters: params.filter((p) => p.in !== "body").map(parameter),
    ...(body.length
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: Object.fromEntries(body.map((p) => [p.name, { ...schemaFor(p.type), description: p.description }])),
                  required: body.filter((p) => p.required).map((p) => p.name),
                },
              },
            },
          },
        }
      : {}),
    responses,
    security: e.access === "public" ? [{}, { bearerAuth: [] }, { basicAuth: [] }] : [{ bearerAuth: [] }, { basicAuth: [] }],
    "x-access": e.access,
    "x-write": !!e.write,
    "x-service-accounts": !!e.serviceAccounts,
    "x-since": e.since,
  };
}

export function openApiDocument(o: { appUrl: string; instanceName?: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of API_CATALOG) {
    const p = `${API_BASE}${e.path === "/" ? "" : e.path}`;
    paths[p] = { ...(paths[p] ?? {}), [e.method.toLowerCase()]: operation(e) };
  }
  const changelog = API_CHANGELOG.map((c) => `### ${c.revision}\n\n${c.changes.map((ch) => `- ${ch}`).join("\n")}`).join("\n\n");
  return {
    openapi: "3.1.0",
    info: {
      title: `${o.instanceName || "Chicorée"} REST API`,
      version: API_REVISION,
      description: `${API_NOTICE}\n\n## Changelog\n\n${changelog}`,
    },
    servers: [{ url: o.appUrl.replace(/\/$/, "") }],
    tags: API_GROUPS.filter((g) => API_CATALOG.some((e) => e.group === g)).map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "A personal access token (chc_pat_…) or service-account secret (chc_sa_…)." },
        basicAuth: { type: "http", scheme: "basic", description: "Any user name with the token as the password." },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error", "code"],
          properties: {
            error: { type: "string", description: "Human-readable message." },
            code: { type: "string", enum: ["bad_request", "unauthorized", "forbidden", "not_found", "conflict", "unprocessable", "api_disabled", "internal"] },
            details: { type: "object", description: "Optional extra context (the offending field, queued: false, …)." },
          },
        },
      },
    },
  };
}
