import Connection from '@sqltools/core/connection';
import ConfigManager from '@sqltools/core/config-manager';
import { ConnectionInterface, DatabaseInterface } from '@sqltools/core/interface';
import SQLTools, { RequestHandler } from '@sqltools/core/plugin-api';
import { getConnectionId } from '@sqltools/core/utils';
import SQLToolsLanguageServer from '@sqltools/language-server/server';
import csvStringify from 'csv-stringify/lib/sync';
import fs from 'fs';
import { ConnectionDataUpdatedRequest, ConnectRequest, DisconnectRequest, GetConnectionDataRequest, GetConnectionPasswordRequest, GetConnectionsRequest, RefreshAllRequest, RunCommandRequest, SaveResultsRequest } from './contracts';
import actions from './store/actions';

export default class ConnectionManagerPlugin implements SQLTools.LanguageServerPlugin {
  private server: SQLToolsLanguageServer;
  private get connections() {
    return ConfigManager.connections || [];
  }

  private getConnectionInstance(creds: ConnectionInterface) {
    const id = getConnectionId(creds);
    const { activeConnections } = this.server.store.getState();
    return <Connection | null>(activeConnections[id] || null);
  }

  private runCommandHandler: RequestHandler<typeof RunCommandRequest> = async ({ conn, args, command }) => {
    try {
      const c = this.getConnectionInstance(conn);
      if (!c) throw 'Connection not found';
      const results: DatabaseInterface.QueryResults[] = await c[command](...args);
      this.server.store.dispatch(actions.QuerySuccess(c, { results }));
      return results;
    } catch (e) {
      this.server.notifyError('Execute query error', e);
      throw e;
    }
  };

  private saveResultsHandler: RequestHandler<typeof SaveResultsRequest> = ({ connId, filename, query, filetype = 'csv' }) => {
    const { queryResults } = this.server.store.getState();
    const { results, cols } = queryResults[connId][query];
    let output = '';
    if (filetype === 'json') {
      output = JSON.stringify(results, null, 2);
    } else if (filetype === 'csv') {
      output = csvStringify(results, {
        columns: cols,
        header: true,
        quoted_string: true,
        quoted_empty: true,
      });
    }
    fs.writeFileSync(filename, output);
  };

  private getTablesAndColumnsHandler: RequestHandler<typeof GetConnectionDataRequest> = async ({ conn }) => {
    if (!conn) {
      return undefined;
    }
    const { activeConnections } = this.server.store.getState();
    if (Object.keys(activeConnections).length === 0) return { tables: [], columns: [] };

    const c = this.getConnectionInstance(conn);
    return { tables: await c.getTables(true), columns: await c.getColumns(true) };
  };

  private refreshConnectionHandler: RequestHandler<typeof RefreshAllRequest> = async () => {
    const activeConnections = this.server.store.getState().activeConnections;
    await Promise.all(Object.keys(activeConnections).map(c => this._loadConnectionData(activeConnections[c])));
  };

  private closeConnectionHandler: RequestHandler<typeof DisconnectRequest> = async ({ conn }): Promise<void> => {
    if (!conn) {
      return undefined;
    }
    const c = this.getConnectionInstance(conn);
    await c.close().catch(this.server.notifyError('Connection Error'));
    this.server.store.dispatch(actions.Disconnect(c));
    conn.isConnected = false;
    await this._updateSidebar(conn, null, null);
  };

  private GetConnectionPasswordRequestHandler: RequestHandler<typeof GetConnectionPasswordRequest> = async ({ conn }): Promise<string> => {
    if (!conn) {
      return undefined;
    }
    const c = this.getConnectionInstance(conn);
    if (c) {
      return c.getPassword();
    }
    return null;
  };

  private openConnectionHandler: RequestHandler<typeof ConnectRequest> = async (req: {
    conn: ConnectionInterface;
    password?: string;
  }): Promise<ConnectionInterface> => {
    if (!req.conn) {
      return undefined;
    }
    let c = this.getConnectionInstance(req.conn) || new Connection(req.conn, this.server.telemetry);

    if (req.password) c.setPassword(req.password);
    return c
      .connect()
      .then(async () => {
        await this._loadConnectionData(c);
        this.server.store.dispatch(actions.Connect(c));
        return c.serialize();
      })
      .catch(e => {
        if (e.data && e.data.notification) {
          this.server.sendNotification(e.data.notification, e.data.args);
        }
        throw e;
      });
  };

  private clientRequestConnectionHandler: RequestHandler<typeof GetConnectionsRequest> = ({ connectedOnly } = {}) => {
    let connList = this.connections;

    if (connectedOnly) connList = connList.filter(c => c.isConnected);

    return connList
      .sort((a, b) => {
        if (a.isConnected === b.isConnected) return a.name.localeCompare(b.name);
        if (a.isConnected && !b.isConnected) return -1;
        if (!a.isConnected && b.isConnected) return 1;
      });
  }

  public register(server: SQLToolsLanguageServer) {
    this.server = this.server || server;

    this.server.onRequest(RunCommandRequest, this.runCommandHandler);
    this.server.onRequest(SaveResultsRequest, this.saveResultsHandler);
    this.server.onRequest(GetConnectionDataRequest, this.getTablesAndColumnsHandler);
    this.server.onRequest(RefreshAllRequest, this.refreshConnectionHandler);
    this.server.onRequest(DisconnectRequest, this.closeConnectionHandler);
    this.server.onRequest(GetConnectionPasswordRequest, this.GetConnectionPasswordRequestHandler);
    this.server.onRequest(ConnectRequest, this.openConnectionHandler);
    this.server.onRequest(GetConnectionsRequest, this.clientRequestConnectionHandler);
    this.server.addOnDidChangeConfigurationHooks(this._autoConnectIfActive);
  }

  // internal utils
  private async _loadConnectionData(conn: Connection) {
    if (!conn) {
      return this._updateSidebar(null, [], []);
    }
    return Promise.all([conn.getTables(), conn.getColumns()])
      .then(async ([tables, columns]) => {
        this.server.store.dispatch(actions.ConnectionData(conn, { tables, columns }))
        return this._updateSidebar(conn.serialize(), tables, columns);
      })
      .catch(e => {
        this.server.notifyError(`Error while preparing columns completions for connection ${conn.getName()}`)(e);
        throw e;
      });
  }

  private _updateSidebar(
    conn: ConnectionInterface,
    tables: DatabaseInterface.Table[],
    columns: DatabaseInterface.TableColumn[]
  ) {
    if (!conn) return Promise.resolve();
    conn.isActive = this.server.store.getState().lastUsedId === getConnectionId(conn);
    return this.server.sendRequest(ConnectionDataUpdatedRequest, { conn, tables, columns });
  }

  public async _autoConnectIfActive() {
    const defaultConnections: ConnectionInterface[] = [];
    const { lastUsedId, activeConnections } = this.server.store.getState();
    if (lastUsedId && activeConnections[lastUsedId]) {
      defaultConnections.push(activeConnections[lastUsedId].serialize());
    }
    if (defaultConnections.length === 0
      && (
        typeof ConfigManager.autoConnectTo === 'string'
        || (
          Array.isArray(ConfigManager.autoConnectTo) && ConfigManager.autoConnectTo.length > 0
          )
        )
    ) {
      const autoConnectTo = Array.isArray(ConfigManager.autoConnectTo)
      ? ConfigManager.autoConnectTo
      : [ConfigManager.autoConnectTo];
      console.info(`Configuration set to auto connect to: ${autoConnectTo}`);

      defaultConnections.push(...ConfigManager.connections
        .filter((conn) => conn && autoConnectTo.indexOf(conn.name) >= 0)
        .filter(Boolean));
    }
    if (defaultConnections.length === 0) {
      return;
    }
    try {
      await Promise.all(defaultConnections.slice(1).map(conn =>
        (<Promise<ConnectionInterface>>this.openConnectionHandler({ conn }))
          .catch(e => {
            this.server.notifyError(`Failed to auto connect to  ${conn.name}`, e);
            return Promise.resolve();
          }),
      ));

      await this.openConnectionHandler({ conn: defaultConnections[0] });
    } catch (error) {
      this.server.notifyError('Auto connect failed', error);
    }
  }
}
