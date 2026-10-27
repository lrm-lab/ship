import { describe, expect, test } from "bun:test";
import { compareSemVer, parseSemVer } from "#src/semver";

describe("parseSemVer (https://semver.org/ 2.0.0)", () => {
  test("splits a version into its parts", () => {
    expect(parseSemVer("1.2.3")).toEqual({
      major: "1",
      minor: "2",
      patch: "3",
      prerelease: [],
      build: [],
    });
    expect(parseSemVer("0.1.3-dev.4")).toEqual({
      major: "0",
      minor: "1",
      patch: "3",
      prerelease: ["dev", "4"],
      build: [],
    });
    expect(parseSemVer("1.0.0-beta+exp.sha.5114f85")).toEqual({
      major: "1",
      minor: "0",
      patch: "0",
      prerelease: ["beta"],
      build: ["exp", "sha", "5114f85"],
    });
  });

  const valid = [
    "0.0.4",
    "10.20.30",
    "1.1.2-prerelease+meta",
    "1.1.2+meta-valid",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-0.3.7",
    "1.0.0-x.7.z.92",
    "1.0.0-x-y-z.--",
    "1.0.0-0A.is.legal",
    "1.0.0+0.build.1-rc.10000aaa-kk-0.1",
    "1.0.0+21AF26D3----117B344092BD",
    "1.0.0+001",
    "99999999999999999999.0.0",
  ];
  for (const version of valid)
    test(`accepts ${version}`, () => expect(parseSemVer(version)).not.toBeNull());

  const invalid = [
    "",
    "1",
    "1.2",
    "1.2.3.4",
    "v1.2.3",
    " 1.2.3",
    "1.2.3 ",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "-1.2.3",
    "1.2.3-",
    "1.2.3+",
    "1.2.3-01",
    "1.2.3-alpha..1",
    "1.2.3-alpha.",
    "1.2.3-+",
    "1.2.3-@",
    "1.2.3+build..1",
    "1.2.3+build_1",
    "1.2.3-0123",
    "1.2.3\n",
    "+invalid",
    "1.2.3-é",
  ];
  for (const version of invalid) {
    test(`rejects ${JSON.stringify(version)}`, () => expect(parseSemVer(version)).toBeNull());
  }
});

describe("compareSemVer", () => {
  const order = (versions: string[]) =>
    [...versions].sort((a, b) => compareSemVer(parseSemVer(a)!, parseSemVer(b)!));

  test("follows the example chain of the specification, lowest first", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
    ];
    expect(order([...chain].reverse())).toEqual(chain);
  });

  test("compares major, minor and patch numerically, not as text", () => {
    const chain = ["0.9.0", "1.0.0", "1.2.0", "1.10.0", "2.0.0", "2.0.1", "10.0.0"];
    expect(order([...chain].reverse())).toEqual(chain);
  });

  test("a prerelease is lower than its release, numeric identifiers lower than alphanumeric", () => {
    expect(order(["1.0.0", "1.0.0-1", "1.0.0-a"])).toEqual(["1.0.0-1", "1.0.0-a", "1.0.0"]);
    expect(order(["0.1.3-dev.10", "0.1.3-dev.9", "0.1.2", "0.1.3"])).toEqual([
      "0.1.2",
      "0.1.3-dev.9",
      "0.1.3-dev.10",
      "0.1.3",
    ]);
  });

  test("build metadata does not affect precedence", () => {
    expect(compareSemVer(parseSemVer("1.0.0+a")!, parseSemVer("1.0.0+b")!)).toBe(0);
    expect(compareSemVer(parseSemVer("1.0.0-rc.1+x")!, parseSemVer("1.0.0-rc.1")!)).toBe(0);
  });

  test("does not lose precision on numbers beyond 2^53", () => {
    expect(
      compareSemVer(parseSemVer("9007199254740993.0.0")!, parseSemVer("9007199254740992.0.0")!),
    ).toBe(1);
    expect(
      compareSemVer(parseSemVer("1.0.0-9007199254740993")!, parseSemVer("1.0.0-9007199254740992")!),
    ).toBe(1);
  });
});
