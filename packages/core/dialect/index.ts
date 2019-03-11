import MSSQL from './mssql';
import MySQL from './mysql';
import OracleDB from './oracle';
import PostgreSQL from './pgsql';
import SQLite from './sqlite';
import IJMacD from './ijmacd-query';

const dialects = {
  MSSQL,
  MySQL,
  PostgreSQL,
  OracleDB,
  SQLite,
  IJMacD,
};

export default dialects;
