import { SQL } from "bun";

export type TestDatabase = {
  /** A connection string for this test file's own database, reachable on 127.0.0.1 only. */
  url: string;
  /** Drops the database (the container stays for the other files of the run). */
  drop(): Promise<void>;
};

const IMAGE = "postgres:17-alpine";
const TEMPLATE = "ship_template";
const root = new URL("../..", import.meta.url).pathname;

async function run(command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}: ${stderr || stdout}`);
  return stdout.trim();
}

/** Runs one statement as the superuser; database names here are generated, never user input. */
async function admin(serverUrl: string, statement: string) {
  const sql = new SQL(`${serverUrl}/postgres`);
  try {
    await sql.unsafe(statement);
  } finally {
    await sql.close().catch(() => {});
  }
}

async function waitUntilReady(serverUrl: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    // The image's init phase runs a temporary server that listens on a unix socket only, so a
    // TCP query succeeding means the final server is up.
    const sql = new SQL(`${serverUrl}/postgres`);
    try {
      await sql`select 1`;
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`PostgreSQL did not become ready: ${error}`);
      await Bun.sleep(250);
    } finally {
      await sql.close().catch(() => {});
    }
  }
}

/**
 * Starts a disposable PostgreSQL in Docker (a fresh container on a random loopback port) and
 * migrates a template database once with `prisma migrate deploy`. It never touches another
 * database. The container lives until the run ends: global-teardown.ts removes it (the exit hook is
 * only a fallback, as `bun test` may not run it).
 */
async function startServer(): Promise<string> {
  const name = `ship-test-pg-${crypto.randomUUID().slice(0, 8)}`;
  const password = crypto.randomUUID();
  const remove = () =>
    Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
  removeContainer = remove;
  process.once("exit", remove);
  try {
    await run([
      "docker",
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      "127.0.0.1::5432",
      IMAGE,
    ]);
    const mapped = await run(["docker", "port", name, "5432/tcp"]);
    const hostPort = /127\.0\.0\.1:(\d+)/.exec(mapped)?.[1];
    if (!hostPort) throw new Error(`Cannot find the mapped port in "${mapped}"`);
    const serverUrl = `postgresql://postgres:${password}@127.0.0.1:${hostPort}`;
    await waitUntilReady(serverUrl);
    await admin(serverUrl, `create database ${TEMPLATE}`);
    await run(["bunx", "--bun", "prisma", "migrate", "deploy"], {
      DATABASE_URL: `${serverUrl}/${TEMPLATE}`,
    });
    return serverUrl;
  } catch (error) {
    remove();
    process.off("exit", remove);
    removeContainer = undefined;
    throw error;
  }
}

let removeContainer: (() => void) | undefined;

/** Removes the shared container. bunfig.toml preloads test/support/global-teardown.ts, which calls it after the last file. */
export function stopSharedPostgres() {
  removeContainer?.();
  removeContainer = undefined;
  server = undefined;
}

let server: Promise<string> | undefined;

/**
 * A database of its own for one test file, copied from the migrated template, on the one
 * PostgreSQL container shared by every file of this `bun test` run. The caller drops it in afterAll.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  server ??= startServer();
  let serverUrl: string;
  try {
    serverUrl = await server;
  } catch (error) {
    server = undefined; // let the next file try again
    throw error;
  }
  const name = `ship_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin(serverUrl, `create database ${name} template ${TEMPLATE}`);
  return {
    url: `${serverUrl}/${name}`,
    drop: () => admin(serverUrl, `drop database if exists ${name} with (force)`),
  };
}
