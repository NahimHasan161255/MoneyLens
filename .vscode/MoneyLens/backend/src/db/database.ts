import { Pool } from "pg";
import type { QueryResult, QueryResultRow } from "pg";

export interface DatabaseHealth {
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface QueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
}

export class PostgresDatabase implements DatabaseHealth, QueryExecutor {
  private readonly pool: Pool;

  constructor(connectionString: string, ssl: boolean) {
    this.pool = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: true } : false,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000
    });
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<Row>> {
    return this.pool.query<Row>(text, values ? [...values] : []);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
