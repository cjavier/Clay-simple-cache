import prisma from '../db/prisma';
import { Company, CreateCompanyParams, CompanyResolution } from '../types';

export const companyService = {
    /**
     * Find a company by references.
     * Priority: domain > linkedin_slug
     */
    async findCompany(keys: { domain?: string; linkedin_slug?: string }): Promise<CompanyResolution> {
        const { domain, linkedin_slug } = keys;

        if (domain) {
            const company = await prisma.company.findUnique({ where: { domain } });
            if (company) return { status: 'ok', company, resolved_by: 'domain' };
        }

        if (linkedin_slug) {
            const company = await prisma.company.findUnique({ where: { linkedin_slug } });
            if (company) return { status: 'ok', company, resolved_by: 'linkedin_slug' };
        }

        return { status: 'ok', company: undefined, resolved_by: undefined };
    },

    /**
     * Safe merge of data JSON
     */
    mergeData(oldData: any, newData: any): any {
        return {
            ...(oldData as object),
            ...newData,
        };
    },

    /**
     * Create a new company
     */
    async createCompany(params: CreateCompanyParams): Promise<Company> {
        return await prisma.company.create({
            data: {
                domain: params.domain,
                linkedin_slug: params.linkedin_slug,
                data: params.data ?? {},
            }
        });
    },

    /**
     * Update an existing company
     */
    async updateCompany(id: string, updates: Partial<Company>): Promise<Company> {
        const { created_at, updated_at, id: _id, ...validUpdates } = updates as any;

        return await prisma.company.update({
            where: { id },
            data: validUpdates
        });
    }
};
