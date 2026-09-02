// First-start provisioning, run before migrations on every container start.
// Idempotent, so it is a no-op on the classic compose stack where the token
// keys are bind-mounted and the Clair database comes from the init script.
//
//  1. ES256 token key pair: created when JWT_PRIVATE_KEY_FILE is missing
//     (the public key goes next to it, or to JWT_PUBLIC_KEY_FILE).
//  2. Clair database: created when CLAIR_URL is set and CLAIR_DB_NAME
//     (default "clair") does not exist yet.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const keyFile = process.env.JWT_PRIVATE_KEY_FILE ?? "/run/secrets/registry-token.key";
const pubFile = process.env.JWT_PUBLIC_KEY_FILE ?? keyFile.replace(/\.key$/, "") + ".pub";

if (!existsSync(keyFile)) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  mkdirSync(path.dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  // registryd runs as a different user and only needs the public half.
  writeFileSync(pubFile, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  console.log(`generated registry token key pair at ${keyFile}`);
}

if (process.env.CLAIR_URL) {
  const name = process.env.CLAIR_DB_NAME ?? "clair";
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    console.error(`CLAIR_DB_NAME "${name}" must be a simple lowercase identifier`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL ?? "postgres://chicoree:chicoree@localhost:5432/chicoree";
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("select 1");
      break;
    } catch (err) {
      if (attempt >= 30) {
        console.error("database never became reachable:", err.message);
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const { rowCount } = await pool.query("select 1 from pg_database where datname = $1", [name]);
  if (rowCount === 0) {
    await pool.query(`create database "${name}"`);
    console.log(`created database ${name} for Clair`);
  }
  await pool.end();
}
