import {
  ConnectionDialect,
  DatabaseInterface,
} from '@sqltools/core/interface';
import * as Utils from '@sqltools/core/utils';
import Query from 'ijmacd-query';
import demoProvider from 'ijmacd-query/src/providers/demo';
import GenericDialect from '../generic';
import queries from './queries';

export default class IJMacD extends GenericDialect<any> implements ConnectionDialect {

  public static deps: typeof GenericDialect['deps'] = [{
    type: 'package',
    name: 'ijmacd-query',
    version: '1.3.0',
  }];


  queries = queries;

  public async open() {
    if (this.connection) {
      return this.connection;
    }

    const db = await new Promise<Query>((resolve, reject) => {
      const instance = new Query;
      instance.addProvider(demoProvider, "Demo");
      return resolve(instance);
    });

    this.connection = Promise.resolve(db);
    return this.connection;
  }

  public async close() {
    this.connection = null;
    Promise.resolve();
  }

  private async runSingleQuery(db: Query, query: string) {
    return db.run(query);
  }

  public async query(query: string): Promise<DatabaseInterface.QueryResults[]> {
    const db = await this.open();
    const queries = Utils.query.parse(query).filter(Boolean);
    const results: DatabaseInterface.QueryResults[] = [];
    for(let i = 0; i < queries.length; i++) {
      const res: any[][] = (await this.runSingleQuery(db, queries[i])) || [];
      const messages = [];
      if (res.length === 0 && queries[i].toLowerCase() !== 'select') {
        messages.push(`${res.length} rows were affected.`);
      }
      const cols = res && res.length ? res[0] : [];
      results.push({
        connId: this.getId(),
        cols,
        messages,
        query: queries[i],
        results: res.slice(1).map(r => zip(cols, r)),
      });
    }
    return results;
  }

  public async getTables(): Promise<DatabaseInterface.Table[]> {
    const [ queryRes ] = await this.query(this.queries.fetchTables);
    return queryRes.results
      .map((obj) => {
        const isView = obj['table_type'].includes("VIEW");
        return {
          name: (isView ? obj['table_schema'] + '.' : '') +  obj['table_name'],
          isView,
          tableDatabase: this.credentials.database,
        } as DatabaseInterface.Table;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  public async getColumns(): Promise<DatabaseInterface.TableColumn[]> {
    const allTables = await this.getTables();
    const columns: DatabaseInterface.TableColumn[] = [];

    await Promise.all(allTables.map(async t => {
      const [{ results }] = await this.describeTable(t.name);

      results.forEach(obj => columns.push({
          columnName: obj['column_name'],
          defaultValue: undefined,
          isNullable: null,
          tableCatalog: obj['table_schema'],
          tableDatabase: this.credentials.database,
          tableName: t.name,
          type: obj['data_type'],
          size: null,
      }));
      return Promise.resolve();
    }));

    return columns.sort((a, b) => a.columnName.localeCompare(b.columnName));
  }
}

function zip (keys: string[], values: any[]): { [key: string]: any } {
  const out = {};
  for (let i = 0; i < keys.length; i++) {
      out[keys[i]] = values[i];
  }
  return out;
}