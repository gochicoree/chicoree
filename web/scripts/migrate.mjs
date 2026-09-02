// Applies the SQL migrations in ./drizzle. Runs on container start (before
// the server) and can be run manually: node scripts/migrate.mjs
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://chicoree:chicoree@localhost:5432/chicoree";

const pool = new pg.Pool({ connectionString: url, max: 1 });

// The database container may still be starting; retry for up to a minute.
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

await migrate(drizzle(pool), { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
console.log("migrations applied");
await pool.end();
