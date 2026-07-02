import { Request, Response } from 'express';
import { normalizeEmail, normalizeLinkedIn, normalizePhone } from '../services/normalization';
import { profileService } from '../services/profile.service';
import { dncService } from '../services/dnc.service';
import { resolveClientOr404 } from './client-resolver';

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

            // Shared keys used to re-resolve the winning row if a concurrent
            // request beats us to a create/update (Prisma P2002).
            const identityKeys = {
                email: normalizedEmail || undefined,
                linkedin_slug: normalizedLinkedin || undefined,
                linkedin_url: fullLinkedinUrl || undefined,
                phone_e164: normalizedPhone?.e164 || undefined
            };

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
                    try {
                        await profileService.updateProfile(existingProfile.id, updates);
                    } catch (error: any) {
                        if (error?.code === 'P2002') {
                            // One of the keys we tried to fill in (e.g. email) was claimed
                            // by a concurrent request between our find and this update.
                            // Re-resolve instead of 500ing.
                            const { profile: refreshed, resolvedBy: refreshedResolvedBy } = await profileService.findProfile(identityKeys);
                            if (!refreshed) throw error;
                            resolutionType = refreshedResolvedBy || resolvedBy;
                            finalProfileId = refreshed.id;
                        } else {
                            throw error;
                        }
                    }
                }

                if (finalProfileId === undefined) {
                    finalProfileId = existingProfile.id;
                    resolutionType = resolvedBy;
                }
            } else {
                // Create
                try {
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
                } catch (error: any) {
                    if (error?.code === 'P2002') {
                        // A concurrent request created a matching profile between our find
                        // and this create. Re-resolve and merge into the winner instead of 500ing.
                        const { profile: raceProfile, resolvedBy: raceResolvedBy } = await profileService.findProfile(identityKeys);
                        if (!raceProfile) throw error;

                        const raceUpdates: any = {};
                        if (normalizedEmail && !raceProfile.email) raceUpdates.email = normalizedEmail;
                        if (normalizedLinkedin && !raceProfile.linkedin_slug) raceUpdates.linkedin_slug = normalizedLinkedin;
                        if (fullLinkedinUrl && !raceProfile.linkedin_url) raceUpdates.linkedin_url = fullLinkedinUrl;
                        if (normalizedPhone?.e164 && !raceProfile.phone_e164) raceUpdates.phone_e164 = normalizedPhone.e164;
                        raceUpdates.data = profileService.mergeData(raceProfile.data, {
                            ...extraData,
                            ...(fullLinkedinUrl ? { linkedin_url: fullLinkedinUrl } : {}),
                            ...(normalizedPhone?.national ? { phone_national: normalizedPhone.national } : {})
                        });

                        let mergedProfile = raceProfile;
                        try {
                            mergedProfile = await profileService.updateProfile(raceProfile.id, raceUpdates);
                        } catch (mergeError: any) {
                            // Yet another concurrent write already filled the same unique
                            // key; fall back to whatever is currently there.
                            if (mergeError?.code !== 'P2002') throw mergeError;
                        }

                        finalProfileId = mergedProfile.id;
                        resolutionType = raceResolvedBy || 'race';
                    } else {
                        throw error;
                    }
                }
            }

            res.json({
                status: 'ok',
                resolved_by: resolutionType,
                profile_id: finalProfileId,
                saved_data: {
                    id: finalProfileId,
                    email: normalizedEmail,
                    linkedin_slug: normalizedLinkedin,
                    linkedin_url: fullLinkedinUrl,
                    phone_e164: normalizedPhone?.e164,
                    data: {
                        ...extraData,
                        ...(fullLinkedinUrl ? { linkedin_url: fullLinkedinUrl } : {}),
                        ...(normalizedPhone?.national ? { phone_national: normalizedPhone.national } : {})
                    }
                }
            });

        } catch (error: any) {
            console.error('Upsert Error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    },

    /**
     * GET /profiles
     * Query by email, linkedin, or phone
     */
    async get(req: Request, res: Response): Promise<void> {
        try {
            const { email, linkedin, linkedin_url, phone, dnc_client } = req.query;
            const linkedinParam = (linkedin || linkedin_url) as string | undefined;

            const normalizedEmail = email ? normalizeEmail(email as string) : undefined;

            // For linkedin, we'll try matching by full URL first, then by slug
            let linkedinUrl = undefined;
            let linkedinSlug = undefined;

            if (linkedinParam) {
                if (linkedinParam.includes('linkedin.com/')) {
                    linkedinUrl = linkedinParam;
                }
                linkedinSlug = normalizeLinkedIn(linkedinParam) || undefined;
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

            // Optional Do-Not-Contact check. Only kicks in when `dnc_client` is
            // provided so existing callers see unchanged behavior/response shape.
            const dncRequested = !!dnc_client;
            if (dncRequested) {
                const client = await resolveClientOr404(res, dnc_client);
                if (!client) return;

                // Prefer the queried email; fall back to the found profile's email.
                const emailToCheck = normalizedEmail || profile?.email || undefined;
                if (emailToCheck) {
                    const dncResult = await dncService.check(client.id, emailToCheck);
                    if (dncResult.do_not_contact) {
                        res.status(200).json({
                            do_not_contact: true,
                            matched_by: dncResult.matched_by,
                        });
                        return;
                    }
                }
            }

            if (!profile) {
                res.status(200).json({
                    result: null,
                    message: "No records found",
                    search_criteria: {
                        email: normalizedEmail,
                        linkedin_url: linkedinUrl,
                        linkedin_slug: linkedinSlug,
                        phone_e164: phoneE164
                    },
                    ...(dncRequested ? { do_not_contact: false } : {})
                });
                return;
            }

            res.json({
                result: 1,
                ...profile.data as object,
                id: profile.id,
                email: profile.email,
                linkedin_slug: profile.linkedin_slug,
                phone: profile.phone_e164,
                updated_at: profile.updated_at,
                ...(dncRequested ? { do_not_contact: false } : {})
            });

        } catch (error: any) {
            console.error('Get Profile Error:', error);
            res.status(500).json({ error: 'Internal server error' });
        }
    }
};
