import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the email-finder module so no real search/verification work happens.
vi.mock("../../src/email-finder", () => ({
  findEmail: vi.fn(),
  verifySingleEmail: vi.fn(),
}));

// Mock the DNC service so we control match outcomes directly.
vi.mock("../../src/services/dnc.service", () => ({
  dncService: {
    check: vi.fn(),
    checkDomain: vi.fn(),
  },
}));

// Mock the client resolver so handle resolution is controllable per test.
vi.mock("../../src/controllers/client-resolver", () => ({
  resolveClientOr404: vi.fn(),
}));

import { emailFinderController } from "../../src/controllers/email-finder.controller";
import { findEmail, verifySingleEmail } from "../../src/email-finder";
import { dncService } from "../../src/services/dnc.service";
import { resolveClientOr404 } from "../../src/controllers/client-resolver";

const mockFindEmail = findEmail as any;
const mockVerifySingleEmail = verifySingleEmail as any;
const mockDncCheck = dncService.check as any;
const mockDncCheckDomain = dncService.checkDomain as any;
const mockResolveClientOr404 = resolveClientOr404 as any;

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("emailFinderController with dnc_client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("find", () => {
    it("skips the search entirely when the domain is blocked", async () => {
      mockResolveClientOr404.mockResolvedValue({ id: "client-1", handle: "acme" });
      mockDncCheckDomain.mockResolvedValue({ do_not_contact: true, matched_by: "domain" });

      const req: any = {
        body: { domain: "acme.com", first_name: "John", dnc_client: "acme" },
      };
      const res = mockRes();

      await emailFinderController.find(req, res);

      expect(mockDncCheckDomain).toHaveBeenCalledWith("client-1", "acme.com");
      expect(mockFindEmail).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ do_not_contact: true, matched_by: "domain" });
    });

    it("blocks after finding an email that turns out to be on the DNC list", async () => {
      mockResolveClientOr404.mockResolvedValue({ id: "client-1", handle: "acme" });
      mockDncCheckDomain.mockResolvedValue({ do_not_contact: false, matched_by: null });
      mockDncCheck.mockResolvedValue({ do_not_contact: true, matched_by: "email" });
      mockFindEmail.mockResolvedValue({ email: "john@acme.com", status: "valid" });

      const req: any = {
        body: { domain: "acme.com", first_name: "John", dnc_client: "acme" },
      };
      const res = mockRes();

      await emailFinderController.find(req, res);

      expect(mockFindEmail).toHaveBeenCalled();
      expect(mockDncCheck).toHaveBeenCalledWith("client-1", "john@acme.com");
      expect(res.json).toHaveBeenCalledWith({ do_not_contact: true, matched_by: "email" });
    });

    it("returns the normal payload plus do_not_contact: false when nothing matches", async () => {
      mockResolveClientOr404.mockResolvedValue({ id: "client-1", handle: "acme" });
      mockDncCheckDomain.mockResolvedValue({ do_not_contact: false, matched_by: null });
      mockDncCheck.mockResolvedValue({ do_not_contact: false, matched_by: null });
      mockFindEmail.mockResolvedValue({ email: "john@acme.com", status: "valid", confidence: 90 });

      const req: any = {
        body: { domain: "acme.com", first_name: "John", dnc_client: "acme" },
      };
      const res = mockRes();

      await emailFinderController.find(req, res);

      const body = res.json.mock.calls[0][0];
      expect(body.email).toBe("john@acme.com");
      expect(body.do_not_contact).toBe(false);
    });

    it("leaves DNC untouched and the response shape unchanged when dnc_client is absent", async () => {
      mockFindEmail.mockResolvedValue({ email: "john@acme.com", status: "valid" });

      const req: any = { body: { domain: "acme.com", first_name: "John" } };
      const res = mockRes();

      await emailFinderController.find(req, res);

      expect(mockResolveClientOr404).not.toHaveBeenCalled();
      expect(mockDncCheckDomain).not.toHaveBeenCalled();
      expect(mockDncCheck).not.toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty("do_not_contact");
    });

    it("propagates the client-not-found response from resolveClientOr404 without searching", async () => {
      mockResolveClientOr404.mockImplementation(async (res: any) => {
        res.status(404).json({ error: "client_not_found", handle: "ghost" });
        return null;
      });

      const req: any = {
        body: { domain: "acme.com", first_name: "John", dnc_client: "ghost" },
      };
      const res = mockRes();

      await emailFinderController.find(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockFindEmail).not.toHaveBeenCalled();
    });
  });

  describe("verify", () => {
    it("blocks without spending a verification when the email is on the DNC list", async () => {
      mockResolveClientOr404.mockResolvedValue({ id: "client-1", handle: "acme" });
      mockDncCheck.mockResolvedValue({ do_not_contact: true, matched_by: "email" });

      const req: any = { body: { email: "john@acme.com", dnc_client: "acme" } };
      const res = mockRes();

      await emailFinderController.verify(req, res);

      expect(mockDncCheck).toHaveBeenCalledWith("client-1", "john@acme.com");
      expect(mockVerifySingleEmail).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ do_not_contact: true, matched_by: "email" });
    });

    it("verifies normally and appends do_not_contact: false when the email is clear", async () => {
      mockResolveClientOr404.mockResolvedValue({ id: "client-1", handle: "acme" });
      mockDncCheck.mockResolvedValue({ do_not_contact: false, matched_by: null });
      mockVerifySingleEmail.mockResolvedValue({ email: "john@acme.com", status: "valid" });

      const req: any = { body: { email: "john@acme.com", dnc_client: "acme" } };
      const res = mockRes();

      await emailFinderController.verify(req, res);

      expect(mockVerifySingleEmail).toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body.do_not_contact).toBe(false);
      expect(body.email).toBe("john@acme.com");
    });

    it("does not call the DNC service or change response shape when dnc_client is absent", async () => {
      mockVerifySingleEmail.mockResolvedValue({ email: "john@acme.com", status: "valid" });

      const req: any = { body: { email: "john@acme.com" } };
      const res = mockRes();

      await emailFinderController.verify(req, res);

      expect(mockDncCheck).not.toHaveBeenCalled();
      expect(mockResolveClientOr404).not.toHaveBeenCalled();
      const body = res.json.mock.calls[0][0];
      expect(body).not.toHaveProperty("do_not_contact");
    });
  });
});
