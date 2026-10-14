import { describe, expect, it } from "vitest";
import { isSfuSuperAdminEmail } from "../src/lib/sfu-super-admin";

describe("SFU super admin email allowlist", () => {
  it.each([
    "SFU_ADMIN_ALLOWLIST_EMAILS",
    "SFU_ADMIN_ALLOWED_EMAILS",
    "SFU_DASHBOARD_ALLOWLIST_EMAILS",
    "SFU_ALWAYS_HOST_EMAILS",
    "SFU_ALWAYS_HOST_EMAIL",
    "ALWAYS_HOST_EMAILS",
    "ALWAYS_HOST_EMAIL",
  ])("recognizes authenticated emails configured in %s", (key) => {
    expect(isSfuSuperAdminEmail(" Admin@Example.com ", {
      [key]: "other@example.com, ADMIN@example.com ",
    })).toBe(true);
  });

  it("requires an exact authenticated email match", () => {
    const env = { SFU_ADMIN_ALLOWLIST_EMAILS: "admin@example.com" };
    expect(isSfuSuperAdminEmail(undefined, env)).toBe(false);
    expect(isSfuSuperAdminEmail("guest@example.com", env)).toBe(false);
    expect(isSfuSuperAdminEmail("admin@example.com.attacker.org", env)).toBe(false);
  });

  it("does not grant super admin through domain or user ID allowlists", () => {
    expect(isSfuSuperAdminEmail("admin@example.com", {
      SFU_ADMIN_ALLOWLIST_DOMAINS: "example.com",
      SFU_ADMIN_ALLOWLIST_USER_IDS: "admin@example.com",
    })).toBe(false);
  });

  it("preserves precedence of primary email configuration", () => {
    const env = {
      SFU_ADMIN_ALLOWLIST_EMAILS: "admin@example.com",
      SFU_ADMIN_ALLOWED_EMAILS: "legacy@example.com",
      SFU_DASHBOARD_ALLOWLIST_EMAILS: "dashboard@example.com",
    };
    expect(isSfuSuperAdminEmail("legacy@example.com", env)).toBe(false);
    expect(isSfuSuperAdminEmail("dashboard@example.com", env)).toBe(false);
  });

  it("prefers the legacy admin setting over the dashboard fallback", () => {
    expect(isSfuSuperAdminEmail("dashboard@example.com", {
      SFU_ADMIN_ALLOWED_EMAILS: "legacy@example.com",
      SFU_DASHBOARD_ALLOWLIST_EMAILS: "dashboard@example.com",
    })).toBe(false);
  });
});
