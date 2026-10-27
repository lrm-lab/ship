import { afterAll } from "bun:test";
import { stopSharedPostgres } from "./postgres";

// Preloaded by bunfig.toml: a hook registered here runs once, after the last test file.
afterAll(() => {
  stopSharedPostgres();
});
