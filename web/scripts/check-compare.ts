// Throwaway checks for lib/compare-shared.ts: `npx tsx scripts/check-compare.ts`
import assert from "node:assert/strict";
import {
  cleanCommand,
  commonPlatforms,
  diffAnnotations,
  diffConfig,
  diffFindings,
  diffLayers,
  layersWithInstructions,
  normalizeFindings,
  signedDelta,
  type Finding,
  type LayerInfo,
} from "../src/lib/compare-shared";

const L = (d: string, size: number, command: string | null = null): LayerInfo => ({ digest: `sha256:${d.padEnd(64, "0")}`, size, command });

// --- layers ---------------------------------------------------------------
{
  const from = [L("a", 100, "ADD rootfs"), L("b", 20, "RUN apk add x")];
  const to = [L("a", 100, "ADD rootfs"), L("c", 30, "RUN apk add y"), L("d", 5, "COPY app")];
  const d = diffLayers(from, to);
  assert.deepEqual(d.rows.map((r) => [r.change, r.layer.digest.slice(7, 8), r.fromIndex, r.toIndex]), [
    ["unchanged", "a", 1, 1],
    ["removed", "b", 2, null],
    ["added", "c", null, 2],
    ["added", "d", null, 3],
  ]);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.equal(d.unchanged, 1);
  assert.equal(d.addedBytes, 35);
  assert.equal(d.removedBytes, 20);
}
{
  // Identical images: everything unchanged, in order.
  const same = [L("a", 1), L("b", 2)];
  const d = diffLayers(same, same);
  assert.deepEqual(d.rows.map((r) => r.change), ["unchanged", "unchanged"]);
  assert.equal(d.added + d.removed, 0);
}
{
  // Entirely different base: all removed then all added.
  const d = diffLayers([L("a", 1)], [L("b", 2)]);
  assert.deepEqual(d.rows.map((r) => r.change), ["removed", "added"]);
}
{
  // Reordered shared layers are still reported as unchanged, once each.
  const d = diffLayers([L("a", 1), L("b", 2)], [L("b", 2), L("a", 1)]);
  assert.deepEqual(d.rows.map((r) => r.change), ["unchanged", "unchanged"]);
  assert.equal(d.rows.length, 2);
  assert.deepEqual(d.rows.map((r) => [r.fromIndex, r.toIndex]), [[2, 1], [1, 2]]);
}
{
  // Empty sides.
  assert.deepEqual(diffLayers([], []).rows, []);
  assert.deepEqual(diffLayers([], [L("a", 1)]).rows.map((r) => r.change), ["added"]);
  assert.deepEqual(diffLayers([L("a", 1)], []).rows.map((r) => r.change), ["removed"]);
}

// --- history → instructions ------------------------------------------------
{
  assert.equal(cleanCommand("/bin/sh -c #(nop) ADD file:abc in /"), "ADD file:abc in /");
  assert.equal(cleanCommand("/bin/sh -c apk add --no-cache curl"), "RUN apk add --no-cache curl");
  assert.equal(cleanCommand(undefined), null);
  const layers = layersWithInstructions(
    [{ digest: "sha256:1", size: 10 }, { digest: "sha256:2", size: 20 }],
    {
      history: [
        { created_by: "/bin/sh -c #(nop) ADD file:x in /" },
        { created_by: "/bin/sh -c #(nop)  CMD [\"/bin/sh\"]", empty_layer: true },
        { created_by: "/bin/sh -c apk add curl" },
      ],
    },
  );
  assert.deepEqual(layers.map((l) => l.command), ["ADD file:x in /", "RUN apk add curl"]);
}

// --- config ---------------------------------------------------------------
{
  const rows = diffConfig(
    { os: "linux", architecture: "arm64", config: { Env: ["PATH=/usr/bin", "VERSION=3.19"], Cmd: ["/bin/sh"], Labels: { a: "1", gone: "x" }, ExposedPorts: { "80/tcp": {} } } },
    { os: "linux", architecture: "arm64", config: { Env: ["PATH=/usr/bin", "VERSION=3.20", "NEW=1"], Cmd: ["/bin/sh"], User: "app", Labels: { a: "1", added: "y" }, ExposedPorts: { "80/tcp": {}, "443/tcp": {} } } },
  );
  const by = (section: string, key: string) => rows.find((r) => r.section === section && r.key === key)!;
  assert.equal(by("env", "PATH").changed, false);
  assert.deepEqual([by("env", "VERSION").from, by("env", "VERSION").to, by("env", "VERSION").changed], ["3.19", "3.20", true]);
  assert.deepEqual([by("env", "NEW").from, by("env", "NEW").to], [null, "1"]);
  assert.equal(by("cmd", "Cmd").changed, false);
  assert.deepEqual([by("user", "User").from, by("user", "User").to, by("user", "User").changed], [null, "app", true]);
  assert.deepEqual([by("labels", "gone").to, by("labels", "added").from], [null, null]);
  assert.deepEqual([by("ports", "ExposedPorts").from, by("ports", "ExposedPorts").to], ["80/tcp", "443/tcp, 80/tcp"]);
  assert.equal(by("platform", "Platform").changed, false);
  // Missing configs on both sides: no crash, nothing changed.
  assert.ok(diffConfig(null, null).every((r) => !r.changed));
  // Argv quoting keeps arguments with spaces readable.
  const q = diffConfig({ config: { Entrypoint: ["sh", "-c", "echo hi"] } }, null).find((r) => r.key === "Entrypoint")!;
  assert.equal(q.from, 'sh -c "echo hi"');
}

// --- annotations ----------------------------------------------------------
{
  const rows = diffAnnotations({ "org.opencontainers.image.version": "3.19", keep: "1" }, { "org.opencontainers.image.version": "3.20", keep: "1" });
  assert.deepEqual(rows.map((r) => [r.key, r.changed]), [["keep", false], ["org.opencontainers.image.version", true]]);
}

// --- findings -------------------------------------------------------------
{
  const F = (id: string, pkg: string, severity: string, fixedIn: string | null = null): Finding => ({ id, name: id, severity, packageName: pkg, packageVersion: "1", fixedIn, link: null });
  const from = [F("CVE-1", "openssl", "High"), F("CVE-2", "zlib", "Low"), F("CVE-3", "busybox", "Unknown")];
  const to = [F("CVE-1", "openssl", "High"), F("CVE-4", "curl", "Critical"), F("CVE-2", "libcrypto", "Low")];
  const d = diffFindings(from, to);
  assert.deepEqual(d.added.map((f) => f.id), ["CVE-4", "CVE-2"]); // Critical first, then Low
  assert.deepEqual(d.fixed.map((f) => f.id), ["CVE-2", "CVE-3"]); // same id, other package counts as fixed here
  assert.deepEqual(d.unchanged.map((f) => f.id), ["CVE-1"]);
  assert.deepEqual(d.addedBySeverity, { Critical: 1, Low: 1 });
  assert.deepEqual(d.fixedBySeverity, { Low: 1, Unknown: 1 });
  assert.deepEqual(diffFindings([], []), { added: [], fixed: [], unchanged: [], addedBySeverity: {}, fixedBySeverity: {} });
}

// --- findings adapter: `findings` column vs. Clair report ----------------
{
  const clair = normalizeFindings({
    report: {
      vulnerabilities: { v1: { name: "CVE-2024-1", normalized_severity: "High", fixed_in_version: "1.1", links: "https://a https://b" }, v2: { name: "CVE-2024-2", normalized_severity: "" } },
      package_vulnerabilities: { p1: ["v1", "v2"], p2: ["v1"], p3: ["missing"] },
      packages: { p1: { name: "openssl", version: "1.0" }, p2: { name: "openssl", version: "1.0" }, p3: { name: "zlib" } },
    },
  });
  assert.deepEqual(clair.map((f) => [f.id, f.packageName, f.severity, f.fixedIn, f.link]), [
    ["v1", "openssl", "High", "1.1", "https://a"],
    ["v2", "openssl", "Unknown", null, null],
  ]); // p2 repeats v1/openssl → deduplicated; p3 points at an unknown vulnerability → skipped
  const column = normalizeFindings({
    findings: [
      { id: "CVE-1", severity: "critical", package: { name: "curl", version: "8.0" }, fixedIn: "8.1", url: "https://x" },
      { vulnerabilityId: "CVE-2", normalizedSeverity: "LOW", packageName: "zlib", packageVersion: "1.3" },
      { id: "CVE-1", package: { name: "curl" } }, // duplicate key
      { name: "GHSA-3", severity: "weird", package: "busybox" },
      null,
      { severity: "High" }, // no id → skipped
    ],
    report: { vulnerabilities: { ignored: { name: "ignored" } }, package_vulnerabilities: { p: ["ignored"] }, packages: { p: { name: "x" } } },
  });
  assert.deepEqual(column.map((f) => [f.id, f.packageName, f.packageVersion, f.severity, f.fixedIn, f.link]), [
    ["CVE-1", "curl", "8.0", "Critical", "8.1", "https://x"],
    ["CVE-2", "zlib", "1.3", "Low", null, null],
    ["GHSA-3", "busybox", "", "Unknown", null, null],
  ]);
  // Both shapes diff against each other by id + package.
  const d = diffFindings(clair, column);
  assert.deepEqual(d.added.map((f) => f.id), ["CVE-1", "CVE-2", "GHSA-3"]);
  assert.deepEqual(d.fixed.map((f) => f.id), ["v1", "v2"]);
  assert.deepEqual(normalizeFindings(null), []);
  assert.deepEqual(normalizeFindings({ report: "garbage" }), []);
}

// --- helpers --------------------------------------------------------------
{
  const fmt = (n: number) => `${n}B`;
  assert.equal(signedDelta(0, fmt), "±0");
  assert.equal(signedDelta(12, fmt), "+12B");
  assert.equal(signedDelta(-3, fmt), "−3B");
  assert.deepEqual(commonPlatforms(["linux/amd64", "linux/arm64"], ["linux/arm64", "linux/s390x"]), { common: ["linux/arm64"], disjoint: false });
  assert.deepEqual(commonPlatforms(["linux/amd64"], ["linux/arm64"]), { common: ["linux/arm64", "linux/amd64"], disjoint: true });
}

console.log("compare-shared: all checks passed");
