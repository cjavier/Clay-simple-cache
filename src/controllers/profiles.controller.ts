import { Request, Response } from 'express';
import { normalizeEmail, normalizeLinkedIn, normalizePhone } from '../services/normalization';
import { profileService } from '../services/profile.service';

export const profilesController = {
    /**
     * POST /profiles
     * Upsert/Enrich profile
     */
    async upsert(req: Request, res: Response): Promise<void> {
        try {
            const { email, linkedin_url, linkedin_profile, phone, ...extraData } = req.body;

            // 1. Normalize Keys
            const normalizedEmail = email ? normalizeEmail(email as string) : null;
            const normalizedLinkedin = (linkedin_url || linkedin_profile) ? normalizeLinkedIn((linkedin_url || linkedin_profile) as string) : null;
            const normalizedPhone = phone ? normalizePhone(phone as string) : null;

            // Full LinkedIn URL to store (if provided)
            const fullLinkedinUrl = (linkedin_url || linkedin_profile) as string | undefined;

            if (!normalizedEmail && !normalizedLinkedin && !normalizedPhone) {
                res.status(400).json({ error: 'At least one identity key (email, linkedin_url, phone) is required.' });
                return;
            }

            // 2. Find existing profile
            const { profile: existingProfile, resolvedBy } = await profileService.findProfile({
                email: normalizedEmail || undefined,
                linkedin_slug: normalizedLinkedin || undefined,
                linkedin_url: fullLinkedinUrl || undefined,
                phone_e164: normalizedPhone?.e164 || undefined
            });

            // 3. Upsert
            let finalProfileId;
            let resolutionType;

            if (existingProfile) {
                // Update
                const updates: any = {};

                // Fill missing keys
                // We ALWAYS attempt to fill these if they are missing in the DB but provided in the request
                if (normalizedEmail && !existingProfile.email) updates.email = normalizedEmail;
                if (normalizedLinkedin && !existingProfile.linkedin_slug) updates.linkedin_slug = normalizedLinkedin;
                if (fullLinkedinUrl && !existingProfile.linkedin_url) updates.linkedin_url = fullLinkedinUrl;
                if (normalizedPhone?.e164 && !existingProfile.phone_e164) updates.phone_e164 = normalizedPhone.e164;

                // Merge Data
                // The requirements say we definitely need to include as many identifiable data as possible
                const mergedData = profileService.mergeData(existingProfile.data, {
                    ...extraData,
                    ...(fullLinkedinUrl ? { linkedin_url: fullLinkedinUrl } : {}),
                    ...(normalizedPhone?.national ? { phone_national: normalizedPhone.national } : {})
                });
                updates.data = mergedData;

                // Perform update if there are changes
                if (Object.keys(updates).length > 0) {
                    await profileService.updateProfile(existingProfile.id, updates);
                }

                finalProfileId = existingProfile.id;
                resolutionType = resolvedBy;
            } else {
                // Create
                const newProfile = await profileService.createProfile({
                    email: normalizedEmail,
                    linkedin_slug: normalizedLinkedin,
                    linkedin_url: fullLinkedinUrl,
                    phone_e164: normalizedPhone?.e164,
                    data: {
                        ...extraData,
                        ...(fullLinkedinUrl ? { linkedin_url: fullLinkedinUrl } : {}),
                        ...(normalizedPhone?.national ? { phone_national: normalizedPhone.national } : {})
                    }
                });
                finalProfileId = newProfile.id;
                resolutionType = 'new';
            }

            res.json({
                status: 'ok',
                resolved_by: resolutionType,
                profile_id: finalProfileId
            });

        } catch (error: any) {
            console.error('Upsert Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    },

    /**
     * GET /profiles
     * Query by email, linkedin, or phone
     */
    async get(req: Request, res: Response): Promise<void> {
        try {
            const { email, linkedin, phone } = req.query;

            const normalizedEmail = email ? normalizeEmail(email as string) : undefined;

            // For linkedin, we'll try matching by full URL first, then by slug
            let linkedinUrl = undefined;
            let linkedinSlug = undefined;

            if (linkedin) {
                const li = linkedin as string;
                if (li.includes('linkedin.com/')) {
                    linkedinUrl = li;
                }
                // Also always try getting the slug anyway
                linkedinSlug = normalizeLinkedIn(li) || undefined;
            }

            let phoneE164 = undefined;
            if (phone) {
                const p = normalizePhone(phone as string);
                if (p) phoneE164 = p.e164;
            }

            const { profile } = await profileService.findProfile({
                email: normalizedEmail,
                linkedin_url: linkedinUrl,
                linkedin_slug: linkedinSlug,
                phone_e164: phoneE164
            });

            if (!profile) {
                res.status(404).json({ error: 'Profile not found' });
                return;
            }

            res.json({
                ...profile.data as object,
                id: profile.id,
                email: profile.email,
                linkedin_slug: profile.linkedin_slug,
                phone: profile.phone_e164,
                updated_at: profile.updated_at
            });

        } catch (error: any) {
            console.error('Get Profile Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    }
};
