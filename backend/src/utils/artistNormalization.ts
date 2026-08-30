import * as fuzz from "fuzzball";

/**
 * Utility functions for normalizing artist and album names
 * to handle case-sensitivity and other variations
 */

/**
 * Canonical name and MBID for compilation/various artists
 */
export const VARIOUS_ARTISTS_CANONICAL = "Various Artists";
export const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

/**
 * Check if an artist name is a variation of "Various Artists"
 * and return the canonical form if so.
 *
 * Uses regex for flexible matching instead of exhaustive list.
 * Covers: VA, V.A., V/A, V.A, Various, Various Artist(s), <Various Artists>, etc.
 */
export function canonicalizeVariousArtists(name: string): string {
    // Strip angle brackets and trim
    const cleaned = name.trim().replace(/^<|>$/g, '');

    // Case-insensitive regex patterns for Various Artists variations
    // Pattern 1: VA, V.A., V/A, V.A (with optional dots/slashes)
    // Pattern 2: Various, Various Artist, Various Artists
    const vaPattern = /^v\.?\s*[\/.]?\s*a\.?$/i;
    const variousPattern = /^various(\s+artists?)?$/i;

    if (vaPattern.test(cleaned) || variousPattern.test(cleaned)) {
        return VARIOUS_ARTISTS_CANONICAL;
    }

    return name;
}

/**
 * Check if a platform-specific artist ID is Various Artists
 */
export function isVariousArtistsById(platform: 'deezer' | 'spotify', id: string | number): boolean {
    if (platform === 'deezer' && String(id) === '5080') {
        return true;
    }
    // Add other platform IDs as needed
    return false;
}

/**
 * Strip diacritics/accents from a string
 * e.g., "Ólafur" → "Olafur", "Björk" → "Bjork"
 */
function stripDiacritics(str: string): string {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Check if a string contains any diacritics/accents
 * Used to prefer the accented version when merging duplicates
 */
export function hasDiacritics(str: string): boolean {
    return str !== stripDiacritics(str);
}

/**
 * Given two artist names, return the "preferred" one
 * Prefers the accented version as it's likely the official spelling
 * e.g., "Olafur Arnalds" vs "Ólafur Arnalds" → "Ólafur Arnalds"
 */
export function getPreferredArtistName(name1: string, name2: string): string {
    const has1 = hasDiacritics(name1);
    const has2 = hasDiacritics(name2);
    
    // If one has accents and the other doesn't, prefer the accented one
    if (has2 && !has1) return name2;
    if (has1 && !has2) return name1;
    
    // If both or neither have accents, prefer the longer/more complete one
    return name1.length >= name2.length ? name1 : name2;
}

/**
 * Normalize an artist name for case-insensitive comparison
 * - Converts to lowercase
 * - Trims whitespace
 * - Strips diacritics/accents (Ólafur → olafur)
 * - Normalizes "&" to "and" (Of Mice & Men → of mice and men)
 * - Normalizes common variations
 * - This ensures "Olafur Arnalds" and "Ólafur Arnalds" match
 * - This ensures "Of Mice & Men" and "Of Mice And Men" match
 */
export function normalizeArtistName(name: string): string {
    let normalized = stripDiacritics(name.trim().toLowerCase());
    
    // Normalize "&" to "and" (handles "Of Mice & Men" vs "Of Mice And Men")
    normalized = normalized.replace(/\s*&\s*/g, ' and ');
    
    // Normalize multiple spaces to single space
    normalized = normalized.replace(/\s+/g, ' ');

    return normalized.trim();
}

/**
 * A punctuation- and whitespace-insensitive key for detecting artists that are
 * the same but tagged slightly differently — e.g. "J. Cole" vs "J Cole", or
 * "M.I.A." vs "MIA". Builds on normalizeArtistName (lowercase, diacritics, &→and)
 * then removes every non-alphanumeric character. Use for duplicate consolidation,
 * NOT for display — it is lossy. Returns "" for names with no alphanumerics.
 */
export function looseArtistKey(name: string): string {
    return normalizeArtistName(name).replace(/[^a-z0-9]/g, "");
}

/**
 * Normalize an album title for case-insensitive comparison
 * - Converts to lowercase
 * - Trims whitespace
 */
export function normalizeAlbumTitle(title: string): string {
    return title.trim().toLowerCase();
}

/**
 * Check if two artist names are similar enough to be considered the same
 * Uses fuzzy matching to catch typos like "the weeknd" vs "the weekend"
 * @param name1 First artist name
 * @param name2 Second artist name
 * @param threshold Similarity threshold (0-100), default 95
 * @returns true if names are similar enough
 */
export function areArtistNamesSimilar(
    name1: string,
    name2: string,
    threshold: number = 95
): boolean {
    // First normalize both names
    const normalized1 = normalizeArtistName(name1);
    const normalized2 = normalizeArtistName(name2);

    // If they're exactly equal after normalization, return true
    if (normalized1 === normalized2) {
        return true;
    }

    // Use fuzzy matching to catch typos
    const similarity = fuzz.ratio(normalized1, normalized2);
    return similarity >= threshold;
}

/**
 * Fuzzy similarity (0-100) between two artist names after normalization.
 * Exposes the raw score so callers can rank candidates and apply ambiguity
 * guards (e.g. duplicate-artist consolidation). "Nickleback" vs "Nickelback"
 * scores ~90 (a letter transposition); an exact normalized match returns 100.
 */
export function artistNameSimilarity(name1: string, name2: string): number {
    const n1 = normalizeArtistName(name1);
    const n2 = normalizeArtistName(name2);
    if (n1 === n2) return 100;
    return fuzz.ratio(n1, n2);
}

/**
 * Find the best matching artist from a list of candidates
 * @param targetName The name to match
 * @param candidates List of candidate artist names
 * @param threshold Minimum similarity score (0-100), default 95
 * @returns The best matching artist name, or null if no good match
 */
export function findBestArtistMatch(
    targetName: string,
    candidates: string[],
    threshold: number = 95
): string | null {
    const normalizedTarget = normalizeArtistName(targetName);

    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
        const normalizedCandidate = normalizeArtistName(candidate);
        const score = fuzz.ratio(normalizedTarget, normalizedCandidate);

        if (score >= threshold && score > bestScore) {
            bestScore = score;
            bestMatch = candidate;
        }
    }

    return bestMatch;
}
