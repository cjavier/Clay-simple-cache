import prisma from '../db/prisma';
import { Profile, CreateProfileParams } from '../types';
import { Prisma } from '@prisma/client';

export const profileService = {
    /**
     * Find a profile by any of the keys.
     * Tries all provided keys and returns the best match (or first found).
     */
    async findProfile(keys: { email?: string; linkedin_slug?: string; linkedin_url?: string; phone_e164?: string }): Promise<{ profile: any | null; resolvedBy: string | null }> {
        const { email, linkedin_slug, linkedin_url, phone_e164 } = keys;

        let foundProfile: any | null = null;
        let resolvedBy: string | null = null;

        // Check for email match first (highest priority)
        if (email) {
            const profile = await prisma.profile.findUnique({ where: { email } });
            if (profile) {
                foundProfile = profile;
                resolvedBy = 'email';
            }
        }

        // Check for linkedin_url match (newly added column)
        if (!foundProfile && linkedin_url) {
            const profile = await prisma.profile.findUnique({ where: { linkedin_url } });
            if (profile) {
                foundProfile = profile;
                resolvedBy = 'linkedin_url';
            }
        }

        // Check for linkedin_slug
        if (!foundProfile && linkedin_slug) {
            const profile = await prisma.profile.findUnique({ where: { linkedin_slug } });
            if (profile) {
                foundProfile = profile;
                resolvedBy = 'linkedin_slug';
            }
        }

        // If no profile found yet, check for phone_e164
        if (!foundProfile && phone_e164) {
            const profile = await prisma.profile.findUnique({ where: { phone_e164 } });
            if (profile) {
                foundProfile = profile;
                resolvedBy = 'phone_e164';
            }
        }

        return { profile: foundProfile, resolvedBy: resolvedBy };
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
                linkedin_url: params.linkedin_url,
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
