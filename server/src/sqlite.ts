import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SqlDatabase, SqlPreparedStatement } from "./types.js";

function resolveDefaultMigrationsDir(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const direct = path.resolve(dir, "../migrations");
  if (existsSync(direct)) return direct;
  // Support downstream adapters (e.g. cloudflare-worker) whose tsc mirrors server/src under dist/server/src.
  const nestedDistFallback = path.resolve(dir, "../../../../server/migrations");
  if (existsSync(nestedDistFallback)) return nestedDistFallback;
  return direct;
}

type PreparedSync = ReturnType<DatabaseSync["prepare"]>;

const MAX_STATEMENT_CACHE_SIZE = 256;

class SqlitePreparedStatement implements SqlPreparedStatement {
  private boundValues: SQLInputValue[] = [];

  constructor(
    private readonly provider: { getPreparedStatement(query: string): PreparedSync },
    private readonly query: string
  ) {}

  bind(...values: unknown[]): SqlPreparedStatement {
    this.boundValues = values.map((val) =>
      val === undefined ? null : (val as SQLInputValue)
    );
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const stmt = this.provider.getPreparedStatement(this.query);
    const row = stmt.get(...this.boundValues);
    return (row ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    const stmt = this.provider.getPreparedStatement(this.query);
    const rows = stmt.all(...this.boundValues);
    return { results: rows as T[] };
  }

  async run(): Promise<unknown> {
    return this.runSync();
  }

  runSync(): unknown {
    const stmt = this.provider.getPreparedStatement(this.query);
    return stmt.run(...this.boundValues);
  }
}

/**
 * Split a migration SQL file into top-level statements while respecting
 * single-quoted strings and `--` line comments.
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === "\n") inLineComment = false;
      continue;
    }

    if (!inSingleQuote && ch === "-" && next === "-") {
      inLineComment = true;
      current += ch;
      continue;
    }

    if (ch === "'") {
      current += ch;
      if (inSingleQuote && next === "'") {
        current += next;
        i += 1;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    if (!inSingleQuote && ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }

    current += ch;
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

const ADD_COLUMN_PATTERN =
  /^ALTER\s+TABLE\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+ADD\s+(?:COLUMN\s+)?["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\b/i;

export interface SqliteDatabaseOptions {
  /**
   * Directory containing sorted `*.sql` migrations.
   * Defaults to `server/migrations`; pass `null` to skip automatic migrations.
   */
  migrationsDir?: string | null;
}

export class SqliteDatabase implements SqlDatabase {
  readonly sqlite: DatabaseSync;
  readonly dbPath: string;
  private readonly statementCache = new Map<string, PreparedSync>();
  private closed = false;

  constructor(dbPath: string, options: SqliteDatabaseOptions = {}) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") {
      const resolved = path.resolve(dbPath);
      mkdirSync(path.dirname(resolved), { recursive: true });
      this.sqlite = new DatabaseSync(resolved);
      this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    } else {
      this.sqlite = new DatabaseSync(":memory:");
    }

    this.sqlite.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");

    const migrationsDir =
      options.migrationsDir === undefined ? resolveDefaultMigrationsDir() : options.migrationsDir;
    if (migrationsDir) {
      this.applyMigrations(migrationsDir);
    }
  }

  private columnExists(tableName: string, columnName: string): boolean {
    const safeTable = tableName.replace(/"/g, "\"\"");
    const rows = this.sqlite
      .prepare(`PRAGMA table_info("${safeTable}")`)
      .all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === columnName);
  }

  applyMigrations(migrationsDir: string): string[] {
    if (!existsSync(migrationsDir)) {
      throw new Error(`Migrations directory does not exist: ${migrationsDir}`);
    }

    this.sqlite.exec(
      `CREATE TABLE IF NOT EXISTS _chaox_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`
    );

    const appliedRows = this.sqlite
      .prepare("SELECT name FROM _chaox_migrations")
      .all() as Array<{ name: string }>;
    const appliedSet = new Set(appliedRows.map((row) => row.name));

    const files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    const newlyApplied: string[] = [];
    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const sql = readFileSync(path.join(migrationsDir, file), "utf8");
      const statements = splitSqlStatements(sql);
      const now = new Date().toISOString();

      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const stmt of statements) {
          const addColMatch = ADD_COLUMN_PATTERN.exec(stmt);
          if (addColMatch) {
            const [, tableName, columnName] = addColMatch;
            if (this.columnExists(tableName, columnName)) {
              // Imported D1/SQLite snapshots may already contain earlier columns without _chaox_migrations.
              continue;
            }
          }
          this.sqlite.exec(stmt);
        }
        this.sqlite
          .prepare("INSERT INTO _chaox_migrations (name, applied_at) VALUES (?, ?)")
          .run(file, now);
        this.sqlite.exec("COMMIT");
        newlyApplied.push(file);
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }

    return newlyApplied;
  }

  getPreparedStatement(query: string): PreparedSync {
    const cached = this.statementCache.get(query);
    if (cached) {
      return cached;
    }
    const stmt = this.sqlite.prepare(query);
    if (this.statementCache.size >= MAX_STATEMENT_CACHE_SIZE) {
      const oldestKey = this.statementCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.statementCache.delete(oldestKey);
      }
    }
    this.statementCache.set(query, stmt);
    return stmt;
  }

  prepare(query: string): SqlPreparedStatement {
    return new SqlitePreparedStatement(this, query);
  }

  async batch(statements: SqlPreparedStatement[]): Promise<unknown[]> {
    // Execute statements synchronously inside a single IMMEDIATE transaction without awaiting
    // between steps so concurrent HTTP requests never interleave inside a shared connection.
    const results: unknown[] = [];
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const stmt of statements) {
        if (stmt instanceof SqlitePreparedStatement) {
          results.push(stmt.runSync());
        } else {
          results.push(await stmt.run());
        }
      }
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statementCache.clear();
    this.sqlite.close();
  }
}

export function createMemoryDatabase(migrationsDir?: string): SqliteDatabase {
  return new SqliteDatabase(":memory:", {
    migrationsDir: migrationsDir ?? resolveDefaultMigrationsDir()
  });
}
