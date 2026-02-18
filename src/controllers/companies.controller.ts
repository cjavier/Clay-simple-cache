import { Request, Response } from 'express';
import { normalizeDomain, normalizeLinkedIn } from '../services/normalization';
import { companyService } from '../services/company.service';

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
                    await companyService.updateCompany(existingCompany.id, updates);
                }

                finalCompanyId = existingCompany.id;
                resolutionType = resolved_by;
            } else {
                // Create
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
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    },

    /**
     * GET /companies
     */
    async get(req: Request, res: Response): Promise<void> {
        try {
            const { domain, linkedin, linkedin_url } = req.query;
            const linkedinParam = (linkedin || linkedin_url) as string | undefined;

            const normalizedDomain = domain ? normalizeDomain(domain as string) : undefined;
            const normalizedLinkedin = linkedinParam ? (normalizeLinkedIn(linkedinParam) || undefined) : undefined;

            const { company } = await companyService.findCompany({
                domain: normalizedDomain || undefined,
                linkedin_slug: normalizedLinkedin
            });

            if (!company) {
                res.status(200).json({
                    result: null,
                    message: "No records found",
                    search_criteria: {
                        domain: normalizedDomain,
                        linkedin_slug: normalizedLinkedin
                    }
                });
                return;
            }

            res.json({
                result: 1,
                ...company.data as object,
                id: company.id,
                domain: company.domain,
                linkedin_slug: company.linkedin_slug,
                updated_at: company.updated_at
            });

        } catch (error: any) {
            console.error('Get Company Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    }
};
