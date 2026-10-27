import { describe, expect, test } from "bun:test";
import { loadConfig } from "#src/config";

const base = {
  APP_ORIGIN: "https://ship.example.com",
  DATABASE_URL: "postgresql://ship:secret@localhost:5432/ship",
};
const issuers = (value: unknown) => JSON.stringify(value);
const load = (trusted: string | undefined, extra: Record<string, string> = {}) =>
  loadConfig({
    ...base,
    ...(trusted === undefined ? {} : { SHIP_TRUSTED_ISSUERS: trusted }),
    ...extra,
  });

describe("loadConfig", () => {
  test("reads several trusted issuers, the origin, the port and the database", () => {
    const config = load(
      issuers([
        { issuer: "https://coforge.cn/oidc", clientId: "ship-prod" },
        { issuer: "https://staging.coforge.cn/oidc", clientId: "ship-staging" },
      ]),
      { PORT: "4100" },
    );
    expect(config.trustedIssuers).toEqual([
      { issuer: "https://coforge.cn/oidc", clientId: "ship-prod" },
      { issuer: "https://staging.coforge.cn/oidc", clientId: "ship-staging" },
    ]);
    expect(config.appOrigin).toBe("https://ship.example.com");
    expect(config.port).toBe(4100);
    expect(config.databaseUrl).toBe(base.DATABASE_URL);
  });

  test("listens on every interface unless HOST says otherwise", () => {
    const trusted = issuers([{ issuer: "https://a.example/oidc", clientId: "x" }]);
    expect(load(trusted).host).toBe("0.0.0.0");
    expect(load(trusted, { HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
  });

  test("accepts http only for a loopback issuer", () => {
    expect(
      load(issuers([{ issuer: "http://127.0.0.1:9000", clientId: "ship" }])).trustedIssuers[0]
        ?.issuer,
    ).toBe("http://127.0.0.1:9000");
    expect(() =>
      load(issuers([{ issuer: "http://coforge.example.com/oidc", clientId: "ship" }])),
    ).toThrow(/https/);
  });

  const bad: [string, string | undefined][] = [
    ["missing", undefined],
    ["not JSON", "{nope"],
    ["not an array", issuers({ issuer: "https://a.example/oidc", clientId: "x" })],
    ["empty", issuers([])],
    ["an entry without clientId", issuers([{ issuer: "https://a.example/oidc" }])],
    ["a blank clientId", issuers([{ issuer: "https://a.example/oidc", clientId: " " }])],
    ["an issuer that is not a URL", issuers([{ issuer: "coforge", clientId: "x" }])],
    [
      "an issuer with a trailing slash",
      issuers([{ issuer: "https://a.example/oidc/", clientId: "x" }]),
    ],
    [
      "a repeated issuer",
      issuers([
        { issuer: "https://a.example/oidc", clientId: "x" },
        { issuer: "https://a.example/oidc", clientId: "y" },
      ]),
    ],
  ];
  for (const [name, value] of bad) {
    test(`rejects SHIP_TRUSTED_ISSUERS that is ${name}`, () => {
      expect(() => load(value)).toThrow(/SHIP_TRUSTED_ISSUERS/);
    });
  }

  test("requires DATABASE_URL and an https APP_ORIGIN without a path", () => {
    const trusted = issuers([{ issuer: "https://a.example/oidc", clientId: "x" }]);
    expect(() =>
      loadConfig({ APP_ORIGIN: base.APP_ORIGIN, SHIP_TRUSTED_ISSUERS: trusted }),
    ).toThrow(/DATABASE_URL/);
    expect(() => load(trusted, { APP_ORIGIN: "http://ship.example.com" })).toThrow(/APP_ORIGIN/);
    expect(() => load(trusted, { APP_ORIGIN: "https://ship.example.com/app" })).toThrow(
      /APP_ORIGIN/,
    );
  });
});
