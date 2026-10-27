import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";

export type Database = { client: PrismaClient; close(): Promise<void> };

/** One pooled PostgreSQL client for the whole process; close it on shutdown. */
export function createDatabase(url: string): Database {
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  return { client, close: () => client.$disconnect() };
}
