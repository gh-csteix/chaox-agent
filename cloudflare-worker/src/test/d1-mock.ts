import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, SQLInputValue } from "node:sqlite";
import { D1LikeDatabase, D1LikePreparedStatement } from "../types.js";

class SqlitePreparedStatement implements D1LikePreparedStatement {
  private boundValues: SQLInputValue[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly query: string
  ) {}

  bind(...values: unknown[]): D1LikePreparedStatement {
    this.boundValues = values.map((val) =>
      val === undefined ? null : (val as SQLInputValue)
    );
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const stmt = this.db.prepare(this.query);
    const row = stmt.get(...this.boundValues);
    return (row ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const stmt = this.db.prepare(this.query);
    const rows = stmt.all(...this.boundValues);
    return { results: rows as T[] };
  }

  async run(): Promise<unknown> {
    const stmt = this.db.prepare(this.query);
    return stmt.run(...this.boundValues);
  }
}

export class SqliteD1Database implements D1LikeDatabase {
  readonly sqlite: DatabaseSync;

  constructor(migrationSqlPaths: string[]) {
    this.sqlite = new DatabaseSync(":memory:");
    for (const filePath of migrationSqlPaths) {
      const sql = readFileSync(filePath, "utf8");
      this.sqlite.exec(sql);
    }
  }

  prepare(query: string): D1LikePreparedStatement {
    return new SqlitePreparedStatement(this.sqlite, query);
  }

  async batch(statements: D1LikePreparedStatement[]): Promise<unknown[]> {
    const results: unknown[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createTestDatabase(): SqliteD1Database {
  const migrationsDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../migrations"
  );
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => path.join(migrationsDir, file));
  return new SqliteD1Database(files);
}
