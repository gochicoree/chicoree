// Map a request to its catalog entry (for metrics labels and deprecation
// headers): the path templates compile to regular expressions once.
import { API_CATALOG, type ApiEndpoint } from "./catalog";
import { API_BASE } from "./version";

const compiled: { endpoint: ApiEndpoint; re: RegExp }[] = API_CATALOG.map((endpoint) => {
  const pattern = (API_BASE + (endpoint.path === "/" ? "" : endpoint.path))
    .split("/")
    .map((seg) => (/^\{\w+\}$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return { endpoint, re: new RegExp(`^${pattern}/?$`) };
});

export function matchEndpoint(method: string, pathname: string): ApiEndpoint | null {
  const m = method.toUpperCase();
  return compiled.find((c) => c.endpoint.method === m && c.re.test(pathname))?.endpoint ?? null;
}

/** HTTP headers announcing a deprecation (RFC 9745 Deprecation, RFC 8594 Sunset, and a link to the docs). */
export function deprecationHeaders(e: ApiEndpoint, docsUrl: string): Record<string, string> {
  if (!e.deprecated) return {};
  const out: Record<string, string> = {};
  const since = Date.parse(e.deprecated.since.slice(0, 10));
  out["Deprecation"] = Number.isFinite(since) ? `@${Math.floor(since / 1000)}` : "true";
  if (e.deprecated.sunset) {
    const sunset = new Date(`${e.deprecated.sunset}T00:00:00Z`);
    if (!Number.isNaN(sunset.getTime())) out["Sunset"] = sunset.toUTCString();
  }
  out["Link"] = `<${docsUrl}>; rel="deprecation"`;
  return out;
}
