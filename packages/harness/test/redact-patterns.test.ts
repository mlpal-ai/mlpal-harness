import { afterEach, describe, expect, test } from "bun:test";
import { clearSecrets, PLATFORM_SECRET_PATTERNS, redactResult, redactText, registerPattern, registerPlatformPatterns, registerSecret } from "../src/index";

const JWT = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiI0MiIsInRva2VuX3VzZSI6ImFjY2VzcyJ9.c2lnbmF0dXJlLXZhbHVlLWhlcmU";

afterEach(() => clearSecrets());

describe("pattern redaction (C8 §8)", () => {
  test("nothing registered: text passes unchanged", () => {
    expect(redactText(`token ${JWT}`)).toBe(`token ${JWT}`);
  });

  test("the platform patterns mask a JWT, every platform key prefix, a sandbox stand-in and a database URL's password", () => {
    registerPlatformPatterns();
    const out = redactText(
      [
        `bearer ${JWT}`,
        "created mlpal_sk_AbCdEf1234567890XY and mlpal_hk_zzzzzzzzzzzzzzzz9 and mlpal_svc_q1w2e3r4t5y6u7i8o9 and cde_sk_00000000aaaabbbbcc",
        "env MLPAL_ACCESS_TOKEN=mlpal-se-0123456789abcdef0123456789abcdef",
        "dsn postgresql://app:s3cr3t-P%40ss@db.internal:5432/app and redis://default:pw123456@cache:6379",
      ].join("\n"),
    );
    expect(out).not.toContain(JWT);
    expect(out).toContain("bearer [redacted:jwt]");
    for (const leaked of ["AbCdEf1234567890XY", "zzzzzzzzzzzzzzzz9", "q1w2e3r4t5y6u7i8o9", "00000000aaaabbbbcc", "0123456789abcdef0123456789abcdef", "s3cr3t", "pw123456"]) expect(out).not.toContain(leaked);
    expect(out).toContain("[redacted:mlpal-key] and [redacted:mlpal-key]");
    expect(out).toContain("MLPAL_ACCESS_TOKEN=[redacted:sandbox-stand-in]");
    // The scheme, user and host stay readable: only the password goes.
    expect(out).toContain("postgresql://app:[redacted:db-url-password]@db.internal:5432/app");
    expect(out).toContain("redis://default:[redacted:db-url-password]@cache:6379");
  });

  test("review F1: a key's display prefix (8 characters, C1 §2.4) stays readable; 16 or more is a key", () => {
    registerPlatformPatterns();
    const line = "[[mlpal:reveal kind=api_key key_id=812 key_prefix=mlpal_sk_abcd1234... label=ci handle=rvl_abcdefghijklmnopqrstuvwxyz234567 expires_at=2026-11-04T21:05:00Z]]";
    expect(redactText(line)).toBe(line);
    expect(redactText("id 812  mlpal_sk_abcd1234...  ci")).toBe("id 812  mlpal_sk_abcd1234...  ci");
    expect(redactText("mlpal_sk_abcd1234efgh5678")).toBe("[redacted:mlpal-key]");
    expect(redactText("mlpal_sk_abcd1234efgh567")).toBe("mlpal_sk_abcd1234efgh567");
  });

  test("a reveal handle and ordinary text are left alone", () => {
    registerPlatformPatterns();
    const text = "[[mlpal:reveal handle=rvl_0123456789abcdef0123456789abcdef kind=api_key prefix=mlpal_sk_ab]] eyJ is a prefix; a.b.c is not a JWT; https://user@host/path";
    expect(redactText(text)).toBe(text);
  });

  test("a known value is masked before the patterns, so its own label wins", () => {
    registerPlatformPatterns();
    registerSecret("mlpal-user-token", JWT);
    expect(redactText(`x ${JWT} y`)).toBe("x [redacted:mlpal-user-token] y");
  });

  test("tool results are masked by pattern too, with no known value registered", () => {
    registerPattern("custom", /\bsecret-[0-9]{4}\b/g);
    expect(redactResult({ content: "got secret-1234" }).content).toBe("got [redacted:custom]");
    expect(redactResult({ content: [{ type: "text", text: "got secret-9999" }] }).content).toEqual([{ type: "text", text: "got [redacted:custom]" }]);
  });

  test("registering twice adds nothing; a non-global pattern is refused", () => {
    registerPlatformPatterns();
    registerPlatformPatterns();
    expect(redactText(`${JWT} ${JWT}`)).toBe("[redacted:jwt] [redacted:jwt]");
    expect(() => registerPattern("once", /x/)).toThrow(/global/);
    expect(PLATFORM_SECRET_PATTERNS.map((p) => p.label)).toEqual(["jwt", "mlpal-key", "sandbox-stand-in", "db-url-password"]);
  });
});
