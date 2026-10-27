import { SQL } from "bun";

export type DisposablePostgres = {
  /** A connection string for the throwaway database, reachable on 127.0.0.1 only. */
  url: string;
  /** Removes the container. Safe to call twice. */
  stop(): Promise<void>;
};

const IMAGE = "postgres:17-alpine";
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

async function waitUntilReady(url: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    // The image's init phase runs a temporary server that listens on a unix socket only, so a
    // TCP query succeeding means the final server is up.
    const sql = new SQL(url);
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
 * Starts a disposable PostgreSQL in Docker (a fresh container on a random loopback port), applies
 * the committed migrations with `prisma migrate deploy`, and returns its URL. It never touches
 * another database: callers must `stop()` it in afterAll. A process that dies first still removes
 * the container through the exit hook.
 */
export async function startDisposablePostgres(): Promise<DisposablePostgres> {
  const name = `ship-test-pg-${crypto.randomUUID().slice(0, 8)}`;
  const password = crypto.randomUUID();
  const remove = () =>
    Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
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
    const url = `postgresql://postgres:${password}@127.0.0.1:${hostPort}/postgres`;
    await waitUntilReady(url);
    await run(["bunx", "--bun", "prisma", "migrate", "deploy"], { DATABASE_URL: url });
    return {
      url,
      async stop() {
        remove();
        process.off("exit", remove);
      },
    };
  } catch (error) {
    remove();
    process.off("exit", remove);
    throw error;
  }
}
