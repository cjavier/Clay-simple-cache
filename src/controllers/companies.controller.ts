import { Request, Response } from 'express';
import { normalizeDomain, normalizeLinkedIn } from '../services/normalization';
import { companyService } from '../services/company.service';
import { dncService } from '../services/dnc.service';
import { resolveClientOr404 } from './client-resolver';

export const companiesController = {
    /**
     * POST /companies
     * Upsert/Enrich company
     */
    async upsert(req: Request, res: Response): Promise<void> {
        try {
            const { domain, linkedin_url, ...extraData } = req.body;

            // 1. Normalize Keys
            const normalizedDomain = domain ? normalizeDomain(domain as string) : null;
            const normalizedLinkedin = linkedin_url ? normalizeLinkedIn(linkedin_url as string) : null;

            if (!normalizedDomain && !normalizedLinkedin) {
                res.status(400).json({ error: 'At least one identifier (domain, linkedin_url) is required.' });
                return;
            }

            // 2. Find existing company
            const { company: existingCompany, resolved_by } = await companyService.findCompany({
                domain: normalizedDomain || undefined,
                linkedin_slug: normalizedLinkedin || undefined
            });

            // 3. Upsert
            let finalCompanyId;
            let resolutionType;

            // Shared keys used to re-resolve the winning row if a concurrent
            // request beats us to a create/update (Prisma P2002).
            const identityKeys = {
                domain: normalizedDomain || undefined,
                linkedin_slug: normalizedLinkedin || undefined
            };

            if (existingCompany) {
                // Update
                const updates: any = {};

                if (normalizedDomain && !existingCompany.domain) updates.domain = normalizedDomain;
                if (normalizedLinkedin && !existingCompany.linkedin_slug) updates.linkedin_slug = normalizedLinkedin;

                const mergedData = companyService.mergeData(existingCompany.data, {
                    ...extraData,
                    ...(linkedin_url ? { linkedin_url } : {})
                });
                updates.data = mergedData;

                if (Object.keys(updates).length > 0) {
                    try {
                        await companyService.updateCompany(existingCompany.id, updates);
                    } catch (error: any) {
                        if (error?.code === 'P2002') {
                            // One of the keys we tried to fill in (e.g. domain) was claimed
                            // by a concurrent request between our find and this update.
                            // Re-resolve instead of 500ing.
                            const { company: refreshed, resolved_by: refreshedResolvedBy } = await companyService.findCompany(identityKeys);
                            if (!refreshed) throw error;
                            resolutionType = refreshedResolvedBy || resolved_by;
                            finalCompanyId = refreshed.id;
                        } else {
                            throw error;
                        }
                    }
                }

                if (finalCompanyId === undefined) {
                    finalCompanyId = existingCompany.id;
                    resolutionType = resolved_by;
                }
            } else {
                // Create
                try {
                    const newCompany = await companyService.createCompany({
                        domain: normalizedDomain,
                        linkedin_slug: normalizedLinkedin,
                        data: {
                            ...extraData,
                            ...(linkedin_url ? { linkedin_url } : {})
                        }
                    });
                    finalCompanyId = newCompany.id;
                    resolutionType = 'new';
                } catch (error: any) {
                    if (error?.code === 'P2002') {
                        // A concurrent request created a matching company between our find
                        // and this create. Re-resolve and merge into the winner instead of 500ing.
                        const { company: raceCompany, resolved_by: raceResolvedBy } = await companyService.findCompany(identityKeys);
                        if (!raceCompany) throw error;

                        const raceUpdates: any = {};
                        if (normalizedDomain && !raceCompany.domain) raceUpdates.domain = normalizedDomain;
                        if (normalizedLinkedin && !raceCompany.linkedin_slug) raceUpdates.linkedin_slug = normalizedLinkedin;
                        raceUpdates.data = companyService.mergeData(raceCompany.data, {
                            ...extraData,
                            ...(linkedin_url ? { linkedin_url } : {})
                        });

                        let mergedCompany = raceCompany;
                        try {
                            mergedCompany = await companyService.updateCompany(raceCompany.id, raceUpdates);
                        } catch (mergeError: any) {
                            // Yet another concurrent write already filled the same unique
                            // key; fall back to whatever is currently there.
                            if (mergeError?.code !== 'P2002') throw mergeError;
                        }

                        finalCompanyId = mergedCompany.id;
                        resolutionType = raceResolvedBy || 'race';
                    } else {
                        throw error;
                    }
                }
            }

            res.json({
                status: 'ok',
                resolved_by: resolutionType,
                company_id: finalCompanyId,
                saved_data: {
                    id: finalCompanyId,
                    domain: normalizedDomain,
                    linkedin_slug: normalizedLinkedin,
                    data: {
                        ...extraData,
                        ...(linkedin_url ? { linkedin_url } : {})
                    }
                }
            });

        } catch (error: any) {
            console.error('Company Upsert Error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    },

    /**
     * GET /companies
     */
    async get(req: Request, res: Response): Promise<void> {
        try {
            const { domain, linkedin, linkedin_url, dnc_client } = req.query;
            const linkedinParam = (linkedin || linkedin_url) as string | undefined;

            const normalizedDomain = domain ? normalizeDomain(domain as string) : undefined;
            const normalizedLinkedin = linkedinParam ? (normalizeLinkedIn(linkedinParam) || undefined) : undefined;

            const { company } = await companyService.findCompany({
                domain: normalizedDomain || undefined,
                linkedin_slug: normalizedLinkedin
            });

            // Optional Do-Not-Contact check. Only kicks in when `dnc_client` is
            // provided so existing callers see unchanged behavior/response shape.
            const dncRequested = !!dnc_client;
            if (dncRequested) {
                const client = await resolveClientOr404(res, dnc_client);
                if (!client) return;

                // Prefer the queried domain; fall back to the found company's domain.
                const domainToCheck = normalizedDomain || company?.domain || undefined;
                if (domainToCheck) {
                    const dncResult = await dncService.checkDomain(client.id, domainToCheck);
                    if (dncResult.do_not_contact) {
                        res.status(200).json({
                            do_not_contact: true,
                            matched_by: dncResult.matched_by,
                        });
                        return;
                    }
                }
            }

            if (!company) {
                res.status(200).json({
                    result: null,
                    message: "No records found",
                    search_criteria: {
                        domain: normalizedDomain,
                        linkedin_slug: normalizedLinkedin
                    },
                    ...(dncRequested ? { do_not_contact: false } : {})
                });
                return;
            }

            res.json({
                result: 1,
                ...company.data as object,
                id: company.id,
                domain: company.domain,
                linkedin_slug: company.linkedin_slug,
                updated_at: company.updated_at,
                ...(dncRequested ? { do_not_contact: false } : {})
            });

        } catch (error: any) {
            console.error('Get Company Error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
};
