import prisma from '../db/prisma';
import { Profile, CreateProfileParams } from '../types';
import { Prisma } from '@prisma/client';

export const profileService = {
    /**
     * Find a profile by any of the keys.
     * Order of priority: email, linkedin_slug, phone_e164
     */
    async findProfile(keys: { email?: string; linkedin_slug?: string; phone_e164?: string }): Promise<{ profile: any | null; resolvedBy: string | null }> {
        const { email, linkedin_slug, phone_e164 } = keys;

        if (email) {
            const profile = await prisma.profile.findUnique({ where: { email } });
            if (profile) return { profile, resolvedBy: 'email' };
        }

        if (linkedin_slug) {
            const profile = await prisma.profile.findUnique({ where: { linkedin_slug } });
            if (profile) return { profile, resolvedBy: 'linkedin_slug' };
        }

        if (phone_e164) {
            const profile = await prisma.profile.findUnique({ where: { phone_e164 } });
            if (profile) return { profile, resolvedBy: 'phone_e164' };
        }

        return { profile: null, resolvedBy: null };
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
     * Create a new profile
     */
    async createProfile(params: CreateProfileParams): Promise<any> {
        return await prisma.profile.create({
            data: {
                email: params.email,
                linkedin_slug: params.linkedin_slug,
                phone_e164: params.phone_e164,
                data: params.data ?? {},
            }
        });
    },

    /**
     * Update an existing profile
     */
    async updateProfile(id: string, updates: Partial<Profile>): Promise<any> {
        const { created_at, updated_at, id: _id, ...validUpdates } = updates as any;

        return await prisma.profile.update({
            where: { id },
            data: validUpdates
        });
    }
};
