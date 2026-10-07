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

export interface TransactionalQueryExecutor extends QueryExecutor {
  transaction<T>(operation: (executor: QueryExecutor) => Promise<T>): Promise<T>;
}

export class PostgresDatabase implements DatabaseHealth, TransactionalQueryExecutor {
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

  async transaction<T>(operation: (executor: QueryExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const executor: QueryExecutor = {
      query: <Row extends QueryResultRow = QueryResultRow>(
        text: string,
        values?: readonly unknown[]
      ) => client.query<Row>(text, values ? [...values] : [])
    };

    try {
      await client.query("BEGIN");
      const result = await operation(executor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Database transaction and rollback failed");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
