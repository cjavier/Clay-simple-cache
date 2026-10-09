// findEmail / verifySingleEmail are the pipeline plus provenance (finder, verifier,
// verdict, checked_at) and the MailBridge evidence push. Import the bare pipeline
// from "./pipeline" only for tests that must not touch the database.
export { findEmail, verifySingleEmail } from "../services/provenance.service";
export { analyzeDomain } from "./domain-intel";
export * from "./types";
