import type { Config } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL || 'file:./data/hazina.db';
const isPostgres =
  databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://');

export default (
  isPostgres
    ? {
        schema: './src/db/schema.ts',
        out: './drizzle',
        dialect: 'postgresql',
        dbCredentials: { url: databaseUrl },
      }
    : {
        schema: './src/db/schema.ts',
        out: './drizzle',
        dialect: 'sqlite',
        dbCredentials: { url: databaseUrl.replace(/^file:/, '') },
      }
) satisfies Config;
