export interface Profile {
    id: string;
    email?: string | null;
    linkedin_slug?: string | null;
    phone_e164?: string | null;
    data: Record<string, any>; // JSONB
    created_at?: string;
    updated_at?: string;
}

export interface CreateProfileParams {
    email?: string | null;
    linkedin_slug?: string | null;
    phone_e164?: string | null;
    data: Record<string, any>;
}

export interface ProfileResolution {
    status: 'ok' | 'error';
    resolved_by?: 'email' | 'linkedin_slug' | 'phone_e164' | 'new';
    profile_id?: string;
    profile?: Profile;
}
