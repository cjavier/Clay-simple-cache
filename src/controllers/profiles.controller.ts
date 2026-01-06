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
            const { email, linkedin_url, phone, ...extraData } = req.body;

            // 1. Normalize Keys
            const normalizedEmail = email ? normalizeEmail(email as string) : null;
            const normalizedLinkedin = linkedin_url ? normalizeLinkedIn(linkedin_url as string) : null;
            const normalizedPhone = phone ? normalizePhone(phone as string) : null;

            if (!normalizedEmail && !normalizedLinkedin && !normalizedPhone) {
                res.status(400).json({ error: 'At least one identity key (email, linkedin_url, phone) is required.' });
                return;
            }

            // 2. Find existing profile
            const { profile: existingProfile, resolvedBy } = await profileService.findProfile({
                email: normalizedEmail || undefined,
                linkedin_slug: normalizedLinkedin || undefined,
                phone_e164: normalizedPhone?.e164 || undefined
            });

            // 3. Upsert
            let finalProfileId;
            let resolutionType;

            if (existingProfile) {
                // Update
                const updates: any = {};

                // Fill missing keys
                if (normalizedEmail && !existingProfile.email) updates.email = normalizedEmail;
                if (normalizedLinkedin && !existingProfile.linkedin_slug) updates.linkedin_slug = normalizedLinkedin;
                if (normalizedPhone?.e164 && !existingProfile.phone_e164) updates.phone_e164 = normalizedPhone.e164;

                // Merge Data
                const mergedData = profileService.mergeData(existingProfile.data, extraData);
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
                    phone_e164: normalizedPhone?.e164,
                    data: extraData
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
            const normalizedLinkedin = linkedin ? (normalizeLinkedIn(linkedin as string) || undefined) : undefined;
            // If passing just a slug, normalizeLinkedIn might fail if it expects URL structure, 
            // but my implementation handles slugs too.
            // If the user passes a slug "ana-lopez", normalizeLinkedIn will return "ana-lopez".

            let phoneE164 = undefined;
            if (phone) {
                // Strategy: "Guardar siempre con LADA... Si viene sin +, intentar +<default_country>..."
                // The implementation of normalizePhone handles default country (MX).
                const p = normalizePhone(phone as string);
                if (p) phoneE164 = p.e164;
            }

            const { profile } = await profileService.findProfile({
                email: normalizedEmail,
                linkedin_slug: normalizedLinkedin,
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
