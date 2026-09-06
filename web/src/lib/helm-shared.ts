// Helm charts as OCI artifacts (helm push): a manifest whose config is the
// chart's Chart.yaml as JSON (application/vnd.cncf.helm.config.v1+json) and
// whose layer is the chart archive. Pure helpers shared by pages, API and
// lists; reading the archive itself lives in lib/helm.ts.
export const HELM_CONFIG = "application/vnd.cncf.helm.config.v1+json";
export const HELM_CHART_LAYER = "application/vnd.cncf.helm.chart.content.v1.tar+gzip";
export const HELM_PROVENANCE_LAYER = "application/vnd.cncf.helm.chart.provenance.v1.prov";

export type RepoKind = "image" | "chart" | "empty";

export interface ChartMaintainer {
  name?: string;
  email?: string;
  url?: string;
}

export interface ChartDependency {
  name?: string;
  version?: string;
  repository?: string;
  condition?: string;
  alias?: string;
}

/** Chart.yaml, as Helm stores it in the config blob. */
export interface ChartMeta {
  apiVersion: string | null;
  name: string;
  version: string;
  appVersion: string | null;
  description: string | null;
  type: string | null;
  home: string | null;
  icon: string | null;
  kubeVersion: string | null;
  deprecated: boolean;
  sources: string[];
  keywords: string[];
  maintainers: ChartMaintainer[];
  dependencies: ChartDependency[];
  annotations: Record<string, string>;
}

export function isHelmConfig(mediaType: string | null | undefined): boolean {
  return (mediaType ?? "").split(";")[0].trim() === HELM_CONFIG;
}

/** Read Chart.yaml metadata from a config blob; null when it is not a chart. */
export function parseChartMeta(config: unknown): ChartMeta | null {
  if (!config || typeof config !== "object") return null;
  const c = config as Record<string, unknown>;
  if (typeof c.name !== "string" || typeof c.version !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const objs = <T,>(v: unknown) => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as T[]) : []);
  const annotations: Record<string, string> = {};
  if (c.annotations && typeof c.annotations === "object") {
    for (const [k, v] of Object.entries(c.annotations as Record<string, unknown>)) if (typeof v === "string") annotations[k] = v;
  }
  return {
    apiVersion: str(c.apiVersion),
    name: c.name,
    version: c.version,
    appVersion: str(c.appVersion),
    description: str(c.description),
    type: str(c.type),
    home: str(c.home),
    icon: str(c.icon),
    kubeVersion: str(c.kubeVersion),
    deprecated: c.deprecated === true,
    sources: strs(c.sources),
    keywords: strs(c.keywords),
    maintainers: objs<ChartMaintainer>(c.maintainers),
    dependencies: objs<ChartDependency>(c.dependencies),
    annotations,
  };
}

/** `oci://registry/path` — what helm commands take (no tag: the version goes in --version). */
export function helmReference(host: string, imagePath: string): string {
  return `oci://${host}/${imagePath}`;
}

export function helmCommands(host: string, imagePath: string, version: string | null, chartName: string) {
  const ref = helmReference(host, imagePath);
  const v = version ? ` --version ${version}` : "";
  return {
    pull: `helm pull ${ref}${v}`,
    install: `helm install ${chartName} ${ref}${v}`,
    showValues: `helm show values ${ref}${v}`,
    push: `helm push ${chartName}-<version>.tgz oci://${host}/${imagePath.includes("/") ? imagePath.slice(0, imagePath.lastIndexOf("/")) : ""}`.replace(/\/$/, ""),
  };
}
