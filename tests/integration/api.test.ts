import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

// Mock Prisma for all integration tests
vi.mock("../../src/services/tech-detector.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/tech-detector.service")>();
  return { ...actual, detectTechnologies: vi.fn() };
});

vi.mock("../../src/db/prisma", () => ({
  default: {
    profile: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    company: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    searchLog: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { cost_usd: 0 } }),
      groupBy: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    domainIntel: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    domainPattern: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    verificationCache: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    client: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    dncEntry: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      createMany: vi.fn(),
    },
  },
}));

import app from "../../src/app";
import prisma from "../../src/db/prisma";
import { detectTechnologies, FetchFailError } from "../../src/services/tech-detector.service";

const mockPrisma = prisma as any;
const mockDetect = detectTechnologies as any;

const API_KEY = "test-integration-key";

describe("API Integration Tests", () => {
  beforeAll(() => {
    process.env.API_KEY = API_KEY;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    mockPrisma.searchLog.count.mockResolvedValue(0);
    mockPrisma.searchLog.aggregate.mockResolvedValue({ _sum: { cost_usd: 0 } });
    mockPrisma.searchLog.groupBy.mockResolvedValue([]);
    mockPrisma.domainIntel.count.mockResolvedValue(0);
    mockPrisma.domainPattern.count.mockResolvedValue(0);
  });

  describe("GET /health", () => {
    it("returns OK", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.text).toBe("OK");
    });
  });

  describe("GET /docs/api", () => {
    it("returns HTML documentation", async () => {
      const res = await request(app).get("/docs/api");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    });
  });

  describe("Authentication", () => {
    it("rejects requests without auth header", async () => {
      const res = await request(app).get("/profiles");
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await request(app)
        .get("/profiles")
        .set("Authorization", "Bearer wrong-key");
      expect(res.status).toBe(401);
    });

    it("accepts requests with valid token", async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ email: "test@test.com" });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /profiles", () => {
    it("returns 400 when no identity keys provided", async () => {
      const res = await request(app)
        .post("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ name: "John Doe" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("At least one identity key");
    });

    it("creates new profile with email", async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      mockPrisma.profile.create.mockResolvedValue({
        id: "new-id",
        email: "john@test.com",
        data: { firstName: "John" },
      });

      const res = await request(app)
        .post("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ email: "John@Test.com", firstName: "John" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.resolved_by).toBe("new");
      expect(res.body.profile_id).toBe("new-id");
    });

    it("updates existing profile", async () => {
      const existing = {
        id: "existing-id",
        email: "john@test.com",
        linkedin_slug: null,
        linkedin_url: null,
        phone_e164: null,
        data: { firstName: "John" },
      };
      mockPrisma.profile.findUnique.mockResolvedValueOnce(existing);
      mockPrisma.profile.update.mockResolvedValue({ ...existing, data: { firstName: "John", company: "Acme" } });

      const res = await request(app)
        .post("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ email: "john@test.com", company: "Acme" });

      expect(res.status).toBe(200);
      expect(res.body.resolved_by).toBe("email");
    });

    it("normalizes email on creation", async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      mockPrisma.profile.create.mockResolvedValue({ id: "id" });

      await request(app)
        .post("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ email: "  JOHN@TEST.COM  " });

      expect(mockPrisma.profile.findUnique).toHaveBeenCalledWith({
        where: { email: "john@test.com" },
      });
    });
  });

  describe("GET /profiles", () => {
    it("returns profile when found", async () => {
      const mockProfile = {
        id: "p1",
        email: "john@test.com",
        linkedin_slug: "john",
        phone_e164: "+5215551234567",
        data: { firstName: "John", company: "Acme" },
        updated_at: new Date(),
      };
      mockPrisma.profile.findUnique.mockResolvedValueOnce(mockProfile);

      const res = await request(app)
        .get("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ email: "john@test.com" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe(1);
      expect(res.body.email).toBe("john@test.com");
      expect(res.body.firstName).toBe("John");
    });

    it("returns null result when not found", async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ email: "nobody@test.com" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeNull();
      expect(res.body.message).toBe("No records found");
    });
  });

  describe("POST /companies", () => {
    it("returns 400 when no identifiers provided", async () => {
      const res = await request(app)
        .post("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ name: "Acme" });
      expect(res.status).toBe(400);
    });

    it("creates new company with domain", async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);
      mockPrisma.company.create.mockResolvedValue({
        id: "c1",
        domain: "acme.com",
        data: {},
      });

      const res = await request(app)
        .post("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ domain: "https://www.acme.com" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.resolved_by).toBe("new");
    });

    it("normalizes domain", async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);
      mockPrisma.company.create.mockResolvedValue({ id: "c1" });

      await request(app)
        .post("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ domain: "HTTPS://WWW.ACME.COM/" });

      expect(mockPrisma.company.findUnique).toHaveBeenCalledWith({
        where: { domain: "acme.com" },
      });
    });
  });

  describe("GET /companies", () => {
    it("returns company when found", async () => {
      const mockCompany = {
        id: "c1",
        domain: "acme.com",
        linkedin_slug: "acme",
        data: { industry: "Tech" },
        updated_at: new Date(),
      };
      mockPrisma.company.findUnique.mockResolvedValueOnce(mockCompany);

      const res = await request(app)
        .get("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ domain: "acme.com" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe(1);
      expect(res.body.domain).toBe("acme.com");
      expect(res.body.industry).toBe("Tech");
    });

    it("returns null result when not found", async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ domain: "nope.com" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeNull();
    });
  });

  describe("POST /find", () => {
    it("returns 400 when domain is missing", async () => {
      const res = await request(app)
        .post("/find")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ first_name: "John" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("domain is required");
    });

    it("returns 400 when no name provided", async () => {
      const res = await request(app)
        .post("/find")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ domain: "acme.com" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("first_name");
    });
  });

  describe("POST /verify", () => {
    it("returns 400 when email is missing", async () => {
      const res = await request(app)
        .post("/verify")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("email is required");
    });
  });

  describe("GET /stats", () => {
    it("returns stats with all fields", async () => {
      const res = await request(app)
        .get("/stats")
        .set("Authorization", `Bearer ${API_KEY}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("total_searches");
      expect(res.body).toHaveProperty("total_valid_found");
      expect(res.body).toHaveProperty("success_rate");
      expect(res.body).toHaveProperty("methods_breakdown");
      expect(res.body).toHaveProperty("total_cost_usd");
      expect(res.body).toHaveProperty("avg_cost_per_email");
      expect(res.body).toHaveProperty("domains_in_cache");
      expect(res.body).toHaveProperty("patterns_learned");
      expect(res.body).toHaveProperty("catch_all_domains");
    });

    it("calculates success_rate correctly", async () => {
      mockPrisma.searchLog.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(75); // valid

      const res = await request(app)
        .get("/stats")
        .set("Authorization", `Bearer ${API_KEY}`);

      expect(res.body.success_rate).toBe(0.75);
    });
  });

  describe("GET / (redirect)", () => {
    it("redirects to /docs/api", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/docs/api");
    });
  });

  describe("POST /detect-tech", () => {
    beforeEach(() => {
      mockDetect.mockReset();
    });

    it("returns 401 without auth header", async () => {
      const res = await request(app)
        .post("/detect-tech")
        .send({ url: "https://example.com" });
      expect(res.status).toBe(401);
    });

    it("returns 400 when url is missing", async () => {
      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("url is required");
    });

    it("returns 400 for invalid URL format", async () => {
      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ url: "://invalid url with spaces" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid URL format");
    });

    it("returns 200 with full TechResult on success", async () => {
      const mockResult = {
        technologies: "WordPress 6.4, Google Tag Manager",
        scripts: ["https://googletagmanager.com/gtm.js?id=GTM-XXX"],
        links: [],
        meta: [{ name: "generator", content: "WordPress 6.4" }],
      };
      mockDetect.mockResolvedValue(mockResult);

      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toBe("https://example.com");
      expect(res.body.technologies).toBe("WordPress 6.4, Google Tag Manager");
      expect(res.body.scripts).toContain("https://googletagmanager.com/gtm.js?id=GTM-XXX");
      expect(res.body.links).toEqual([]);
      expect(res.body.meta).toContainEqual({ name: "generator", content: "WordPress 6.4" });
    });

    it("returns 200 with success:false and reason=timeout on FetchFailError timeout", async () => {
      mockDetect.mockRejectedValue(new FetchFailError("timeout", undefined, "Request timed out after 15s"));

      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.reason).toBe("timeout");
    });

    it("returns 200 with success:false and reason=blocked_by_site on FetchFailError blocked", async () => {
      mockDetect.mockRejectedValue(new FetchFailError("blocked_by_site", 403, "Site blocked the request (HTTP 403)"));

      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.reason).toBe("blocked_by_site");
      expect(res.body.http_status).toBe(403);
    });
  });

  describe("POST /clients", () => {
    it("returns 401 without auth", async () => {
      const res = await request(app).post("/clients").send({ name: "Acme" });
      expect(res.status).toBe(401);
    });

    it("returns 400 when name is missing", async () => {
      const res = await request(app)
        .post("/clients")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("name is required");
    });

    it("creates a client and derives the handle from the name", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      mockPrisma.client.create.mockImplementation(({ data }: any) => ({
        id: "cl1",
        ...data,
      }));

      const res = await request(app)
        .post("/clients")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ name: "Acme Corp México", plan: "pro" });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("ok");
      expect(res.body.client.handle).toBe("acme-corp-mexico");
      expect(res.body.client.name).toBe("Acme Corp México");
      expect(res.body.client.data).toEqual({ plan: "pro" });
    });

    it("returns 409 when the handle already exists", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: "cl1", handle: "acme", name: "Acme" });

      const res = await request(app)
        .post("/clients")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ name: "Acme" });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("client_already_exists");
    });
  });

  describe("GET /clients", () => {
    it("lists clients", async () => {
      mockPrisma.client.findMany.mockResolvedValue([
        { id: "cl1", handle: "acme", name: "Acme" },
        { id: "cl2", handle: "globex", name: "Globex" },
      ]);

      const res = await request(app)
        .get("/clients")
        .set("Authorization", `Bearer ${API_KEY}`);

      expect(res.status).toBe(200);
      expect(res.body.result).toBe(2);
      expect(res.body.clients).toHaveLength(2);
    });

    it("fetches a single client by handle", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: "cl1", handle: "acme", name: "Acme" });

      const res = await request(app)
        .get("/clients")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ handle: "Acme" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe(1);
      expect(res.body.client.handle).toBe("acme");
    });

    it("returns 404 with suggestions when handle not found", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      mockPrisma.client.findMany.mockResolvedValue([{ handle: "acme" }, { handle: "globex" }]);

      const res = await request(app)
        .get("/clients")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ handle: "acmee" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("client_not_found");
      expect(res.body.suggestions).toContain("acme");
    });
  });

  describe("POST /dnc", () => {
    it("returns 400 when list_type is invalid", async () => {
      const res = await request(app)
        .post("/dnc")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acme", list_type: "bogus", entries: ["a@b.com"] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("list_type");
    });

    it("returns 400 when no entries provided", async () => {
      const res = await request(app)
        .post("/dnc")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acme", list_type: "individual" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("At least one entry");
    });

    it("returns 404 with suggestions when client handle is unknown", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      mockPrisma.client.findMany.mockResolvedValue([{ handle: "acme" }]);

      const res = await request(app)
        .post("/dnc")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acmee", list_type: "individual", entries: ["a@b.com"] });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("client_not_found");
      expect(res.body.suggestions).toContain("acme");
    });

    it("uploads individual emails", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: "cl1", handle: "acme", name: "Acme" });
      mockPrisma.dncEntry.findMany.mockResolvedValue([]);
      mockPrisma.dncEntry.createMany.mockResolvedValue({ count: 2 });

      const res = await request(app)
        .post("/dnc")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acme", list_type: "individual", entries: ["A@x.com", "b@y.com", "not-an-email"] });

      expect(res.status).toBe(200);
      expect(res.body.added).toBe(2);
      expect(res.body.invalid).toContain("not-an-email");
      expect(mockPrisma.dncEntry.createMany).toHaveBeenCalled();
    });

    it("decomposes an email into a blocked domain for a domain list", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: "cl1", handle: "acme", name: "Acme" });
      mockPrisma.dncEntry.findMany.mockResolvedValue([]);
      mockPrisma.dncEntry.createMany.mockResolvedValue({ count: 1 });

      const res = await request(app)
        .post("/dnc")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acme", list_type: "domain", entries: ["spammer@evilcorp.com"] });

      expect(res.status).toBe(200);
      expect(res.body.added).toBe(1);
      const inserted = mockPrisma.dncEntry.createMany.mock.calls[0][0].data;
      expect(inserted[0]).toMatchObject({
        list_type: "domain",
        domain: "evilcorp.com",
        email: "spammer@evilcorp.com",
      });
    });

    it("skips duplicates already present", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: "cl1", handle: "acme", name: "Acme" });
      mockPrisma.dncEntry.findMany.mockResolvedValue([
        { list_type: "individual", email: "a@x.com", domain: null },
      ]);
      mockPrisma.dncEntry.createMany.mockResolvedValue({ count: 0 });

      const res = await request(app)
        .post("/dnc")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acme", list_type: "individual", entries: ["a@x.com"] });

      expect(res.status).toBe(200);
      expect(res.body.added).toBe(0);
      expect(res.body.skipped_duplicates).toBe(1);
      expect(mockPrisma.dncEntry.createMany).not.toHaveBeenCalled();
    });
  });

  describe("POST /dnc/check", () => {
    it("returns 400 when email is missing", async () => {
      const res = await request(app)
        .post("/dnc/check")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acme" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("email is required");
    });

    it("returns 400 when handle is missing", async () => {
      const res = await request(app)
        .post("/dnc/check")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ email: "a@b.com" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("handle is required");
    });

    it("returns 404 with suggestions for unknown handle", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      mockPrisma.client.findMany.mockResolvedValue([{ handle: "acme" }]);

      const res = await request(app)
        .post("/dnc/check")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acmee", email: "a@b.com" });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("client_not_found");
      expect(res.body.suggestions).toContain("acme");
    });

    it("returns 200 do_not_contact=true when matched", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: "cl1", handle: "acme", name: "Acme" });
      mockPrisma.dncEntry.findFirst.mockResolvedValue({
        id: "e1",
        list_type: "domain",
        email: null,
        domain: "evilcorp.com",
      });

      const res = await request(app)
        .post("/dnc/check")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acme", email: "Anyone@EvilCorp.com" });

      expect(res.status).toBe(200);
      expect(res.body.do_not_contact).toBe(true);
      expect(res.body.matched_by).toBe("domain");
      expect(res.body.email).toBe("anyone@evilcorp.com");
    });

    it("returns 200 do_not_contact=false when not matched", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: "cl1", handle: "acme", name: "Acme" });
      mockPrisma.dncEntry.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .post("/dnc/check")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ handle: "acme", email: "ok@good.com" });

      expect(res.status).toBe(200);
      expect(res.body.do_not_contact).toBe(false);
      expect(res.body.matched_by).toBeNull();
    });
  });

  describe("GET /dnc", () => {
    it("lists a client's entries", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ id: "cl1", handle: "acme", name: "Acme" });
      mockPrisma.dncEntry.findMany.mockResolvedValue([
        { id: "e1", list_type: "individual", email: "a@x.com", domain: null },
      ]);

      const res = await request(app)
        .get("/dnc")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ handle: "acme" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe(1);
      expect(res.body.entries).toHaveLength(1);
    });
  });
});
