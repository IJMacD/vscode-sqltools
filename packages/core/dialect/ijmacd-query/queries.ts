import { DialectQueries } from '@sqltools/core/interface';

export default {
  describeTable: 'FROM information_schema.columns WHERE table_name = \':table\'',
  fetchRecords: 'SELECT * FROM :table LIMIT :limit',
  fetchTables: `FROM information_schema.tables`,
} as DialectQueries;