import { describe, it, expect } from "vitest";
import {
  resolveIdentity,
  namePartsFromSlug,
  slugFromLinkedIn,
} from "../../src/email-finder/identity";
import { generateCandidates, identifyPatternForSurnames } from "../../src/email-finder/permutator";

describe("slugFromLinkedIn", () => {
  it("pulls the slug out of a full profile URL", () => {
    expect(slugFromLinkedIn("https://www.linkedin.com/in/roberto-lozano-martinez-011251131/"))
      .toBe("roberto-lozano-martinez-011251131");
  });

  it("passes a bare slug through", () => {
    expect(slugFromLinkedIn("roberto-lozano-martinez")).toBe("roberto-lozano-martinez");
  });

  it("handles /pub/ URLs and query strings", () => {
    expect(slugFromLinkedIn("http://linkedin.com/pub/ana-ruiz-b12?trk=x")).toBe("ana-ruiz-b12");
  });

  it("returns null for empty input", () => {
    expect(slugFromLinkedIn("")).toBeNull();
  });
});

describe("namePartsFromSlug", () => {
  it("drops the trailing uniqueness id", () => {
    expect(namePartsFromSlug("roberto-lozano-martinez-011251131"))
      .toEqual(["roberto", "lozano", "martinez"]);
  });

  it("decodes percent-encoded accents and strips them", () => {
    expect(namePartsFromSlug("h%C3%A9ctor-cabrera-valladares-5b001222"))
      .toEqual(["hector", "cabrera", "valladares"]);
  });

  it("drops surname particles, which the permutator re-glues itself", () => {
    expect(namePartsFromSlug("francisco-del-rio-9a1")).toEqual(["francisco", "rio"]);
  });

  it("keeps a numeric-free trailing token — it may be a real surname", () => {
    expect(namePartsFromSlug("maria-fernanda-reinoso")).toEqual(["maria", "fernanda", "reinoso"]);
  });

  it("survives a malformed percent escape instead of losing the name", () => {
    expect(namePartsFromSlug("jose-p%rez-garcia")).toContain("jose");
  });
});

describe("resolveIdentity", () => {
  it("recovers the paternal surname the caller did not send", () => {
    // The real shape of the problem: Clay sends the maternal surname.
    const id = resolveIdentity({
      first_name: "Roberto",
      last_name: "Martinez",
      linkedin_slug: "roberto-lozano-martinez-011251131",
    });
    expect(id.first).toBe("roberto");
    expect(id.surnames[0]).toBe("lozano");
    expect(id.source).toBe("linkedin");
  });

  it("still keeps the caller's surname as a fallback", () => {
    // 16.5% of addresses really do use the maternal surname.
    const id = resolveIdentity({
      first_name: "Roberto",
      last_name: "Martinez",
      linkedin_slug: "roberto-lozano-martinez-011251131",
    });
    expect(id.surnames).toContain("martinez");
  });

  it("puts the paternal surname before the maternal one with a middle name", () => {
    const id = resolveIdentity({
      first_name: "Julio",
      last_name: "Pizano",
      linkedin_slug: "julio-giovanni-velazquez-pizano-1a2b3c4d",
    });
    expect(id.surnames[0]).toBe("velazquez");
    expect(id.second_given).toBe("giovanni");
  });

  it("reads a full_name when there is no slug", () => {
    const id = resolveIdentity({ full_name: "Juan Pérez García" });
    expect(id.first).toBe("juan");
    expect(id.surnames[0]).toBe("perez");
    expect(id.source).toBe("full_name");
  });

  it("falls back to the given names when nothing richer is available", () => {
    const id = resolveIdentity({ first_name: "Ana", last_name: "Ruiz" });
    expect(id).toMatchObject({ first: "ana", surnames: ["ruiz"], source: "given" });
  });

  it("accepts a LinkedIn URL with no name fields at all", () => {
    const id = resolveIdentity({
      linkedin_url: "https://www.linkedin.com/in/adrian-gonzalez-aguirre-832b45178/",
    });
    expect(id.first).toBe("adrian");
    expect(id.surnames[0]).toBe("gonzalez");
  });

  it("does not invent surnames from a one-token slug", () => {
    const id = resolveIdentity({ first_name: "Ana", last_name: "Ruiz", linkedin_slug: "anaruiz" });
    expect(id.surnames).toEqual(["ruiz"]);
  });
});

describe("generateCandidates", () => {
  it("leads with the paternal surname, so five tries beat the old fifteen", () => {
    const id = resolveIdentity({
      first_name: "Roberto",
      last_name: "Martinez",
      linkedin_slug: "roberto-lozano-martinez-011251131",
    });
    const candidates = generateCandidates(id.first, id.surnames, "ctscorp.com", id.second_given);
    // The real address. Unreachable from {Roberto, Martinez} at any depth.
    expect(candidates.slice(0, 5)).toContain("rlozano@ctscorp.com");
  });

  it("adds the compound-initial spelling the pattern table cannot express", () => {
    const id = resolveIdentity({
      first_name: "José Carlos",
      last_name: "Morente",
      linkedin_slug: "jose-carlos-morente-jimenez-7c21",
    });
    const candidates = generateCandidates(id.first, id.surnames, "maxtec.com.mx", id.second_given);
    expect(candidates).toContain("jcmorente@maxtec.com.mx");
  });

  it("never repeats a candidate across surname variants", () => {
    const candidates = generateCandidates("ana", ["ruiz", "ruiz", "ruizlopez"], "acme.com");
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("still produces something when only a first name is known", () => {
    const candidates = generateCandidates("ana", [], "acme.com");
    expect(candidates).toContain("ana@acme.com");
  });

  it("returns nothing for an empty identity rather than junk", () => {
    expect(generateCandidates("", [], "acme.com")).toEqual([]);
  });
});

describe("identifyPatternForSurnames", () => {
  it("explains an address the single-surname version cannot", () => {
    // This returning null is why LATAM domains learned no pattern.
    expect(identifyPatternForSurnames("rlozano@ctscorp.com", "roberto", ["martinez"])).toBeNull();
    expect(
      identifyPatternForSurnames("rlozano@ctscorp.com", "roberto", ["lozano", "martinez"])
    ).toBe("flast");
  });

  it("prefers the first surname that explains the address", () => {
    expect(
      identifyPatternForSurnames("juan.perez@acme.com", "juan", ["perez", "garcia"])
    ).toBe("first.last");
  });
});
