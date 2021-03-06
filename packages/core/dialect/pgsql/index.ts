import { Pool } from 'pg';
import Queries from './queries';
import { ConnectionDialect, DatabaseInterface } from '@sqltools/core/interface';
import GenericDialect from '@sqltools/core/dialect/generic';
import * as Utils from '@sqltools/core/utils';

export default class PostgreSQL extends GenericDialect<Pool> implements ConnectionDialect {
  queries = Queries;
  public open() {
    if (this.connection) {
      return this.connection;
    }
    const pool = new Pool({
      database: this.credentials.database,
      host: this.credentials.server,
      password: this.credentials.password,
      port: this.credentials.port,
      statement_timeout: this.credentials.connectionTimeout * 1000,
      user: this.credentials.username,
    });
    return pool.connect()
      .then(cli => {
        cli.release();
        this.connection = Promise.resolve(pool);
        return this.connection;
      });
  }

  public async close() {
    if (!this.connection) return Promise.resolve();
    const pool = await this.connection;
    this.connection = null;
    pool.end();
  }

  public query(query: string): Promise<DatabaseInterface.QueryResults[]> {
    return this.open()
      .then((conn) => conn.query(query))
      .then((results: any[] | any) => {
        const queries = Utils.query.parse(query);
        const messages = [];
        if (!Array.isArray(results)) {
          results = [results];
        }

        return results.map((r, i): DatabaseInterface.QueryResults => {
          if (r.rows.length === 0 && r.command.toLowerCase() !== 'select') {
            messages.push(`${r.rowCount} rows were affected.`);
          }
          return {
            connId: this.getId(),
            cols: (r.fields || []).map(({ name }) => name),
            messages,
            query: queries[i],
            results: r.rows,
          };
        });
      });
  }

  public getTables(): Promise<DatabaseInterface.Table[]> {
    return this.query(this.queries.fetchTables)
      .then(([queryRes]) => {
        return queryRes.results
          .reduce((prev, curr) => prev.concat(curr), [])
          .map((obj) => {
            return {
              name: obj.tablename,
              isView: !!obj.isview,
              numberOfColumns: parseInt(obj.numberofcolumns, 10),
              tableCatalog: obj.tablecatalog,
              tableDatabase: obj.dbname,
              tableSchema: obj.tableschema,
            } as DatabaseInterface.Table;
          })
          .sort();
      });
  }

  public getColumns(): Promise<DatabaseInterface.TableColumn[]> {
    return this.query(this.queries.fetchColumns)
      .then(([queryRes]) => {
        return queryRes.results
          .reduce((prev, curr) => prev.concat(curr), [])
          .map((obj) => {
            return {
              columnName: obj.columnname,
              defaultValue: obj.defaultvalue,
              isNullable: !!obj.isnullable ? obj.isnullable.toString() === 'yes' : null,
              size: obj.size !== null ? parseInt(obj.size, 10) : null,
              tableCatalog: obj.tablecatalog,
              tableDatabase: obj.dbname,
              tableName: obj.tablename,
              tableSchema: obj.tableschema,
              type: obj.type,
            } as DatabaseInterface.TableColumn;
          })
          .sort();
      });
  }
}