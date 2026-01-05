import { Profile as PrismaProfile, Prisma } from '@prisma/client';

export type Profile = PrismaProfile;

export interface CreateProfileParams {
    email?: string | null;
    linkedin_slug?: string | null;
    phone_e164?: string | null;
    data?: Prisma.InputJsonValue;
}

export interface ProfileResolution {
    status: 'ok' | 'error';
    resolved_by?: 'email' | 'linkedin_slug' | 'phone_e164' | 'new';
    profile_id?: string;
    profile?: Profile;
}
