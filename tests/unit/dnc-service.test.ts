import { describe, it, expect } from "vitest";
import { dncService } from "../../src/services/dnc.service";

describe("dncService.prepareEntry", () => {
  describe("individual list", () => {
    it("accepts and normalizes an email", () => {
      expect(dncService.prepareEntry("  John@Acme.COM ", "individual")).toEqual({
        list_type: "individual",
        email: "john@acme.com",
        domain: null,
      });
    });

    it("rejects a bare domain (not an email)", () => {
      expect(dncService.prepareEntry("acme.com", "individual")).toBeNull();
    });

    it("rejects a malformed email", () => {
      expect(dncService.prepareEntry("john@localhost", "individual")).toBeNull();
    });

    it("rejects empty input", () => {
      expect(dncService.prepareEntry("   ", "individual")).toBeNull();
    });
  });

  describe("domain list", () => {
    it("accepts and normalizes a bare domain", () => {
      expect(dncService.prepareEntry("https://www.Acme.com/", "domain")).toEqual({
        list_type: "domain",
        email: null,
        domain: "acme.com",
      });
    });

    it("decomposes an email: blocks the domain and keeps the original email", () => {
      expect(dncService.prepareEntry("John@Acme.com", "domain")).toEqual({
        list_type: "domain",
        email: "john@acme.com",
        domain: "acme.com",
      });
    });

    it("handles subdomains in emails", () => {
      expect(dncService.prepareEntry("jane@mail.acme.com", "domain")).toEqual({
        list_type: "domain",
        email: "jane@mail.acme.com",
        domain: "mail.acme.com",
      });
    });

    it("rejects an invalid domain", () => {
      expect(dncService.prepareEntry("localhost", "domain")).toBeNull();
    });
  });
});
