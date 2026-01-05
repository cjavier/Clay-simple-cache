import { supabase } from '../db/supabase';
import { Profile, CreateProfileParams } from '../types';

export const profileService = {
    /**
     * Find a profile by any of the keys.
     * Order of priority: email, linkedin_slug, phone_e164
     */
    async findProfile(keys: { email?: string; linkedin_slug?: string; phone_e164?: string }): Promise<{ profile: Profile | null; resolvedBy: string | null }> {
        const { email, linkedin_slug, phone_e164 } = keys;

        if (email) {
            const { data } = await supabase.from('profiles').select('*').eq('email', email).single();
            if (data) return { profile: data, resolvedBy: 'email' };
        }

        if (linkedin_slug) {
            const { data } = await supabase.from('profiles').select('*').eq('linkedin_slug', linkedin_slug).single();
            if (data) return { profile: data, resolvedBy: 'linkedin_slug' };
        }

        if (phone_e164) {
            const { data } = await supabase.from('profiles').select('*').eq('phone_e164', phone_e164).single();
            if (data) return { profile: data, resolvedBy: 'phone_e164' };
        }

        return { profile: null, resolvedBy: null };
    },

    /**
     * Safe merge of data JSON
     */
    mergeData(oldData: Record<string, any>, newData: Record<string, any>): Record<string, any> {
        return {
            ...oldData,
            ...newData,
        };
    },

    /**
     * Create a new profile
     */
    async createProfile(params: CreateProfileParams): Promise<Profile> {
        const { data, error } = await supabase
            .from('profiles')
            .insert({
                email: params.email,
                linkedin_slug: params.linkedin_slug,
                phone_e164: params.phone_e164,
                data: params.data
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    },

    /**
     * Update an existing profile
     */
    async updateProfile(id: string, updates: Partial<Profile>): Promise<Profile> {
        const { data, error } = await supabase
            .from('profiles')
            .update({
                ...updates,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;
        return data;
    }
};
