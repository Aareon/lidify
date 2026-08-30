import { prisma } from "../utils/db";
import { looseArtistKey, artistNameSimilarity } from "../utils/artistNormalization";

/**
 * Library Health — detects data anomalies an admin can review and remediate on
 * the Settings → Library Health screen. Currently detects duplicate artists;
 * the Anomaly shape is a discriminated union so more types can be added later
 * (orphaned albums, temp-MBID artists needing enrichment, corrupt-tag imports…)
 * without changing the transport or the frontend framework.
 */

// Fuzzy matching thresholds for duplicate detection. Deliberately conservative:
// only temp-MBID rows are ever proposed for merging into a real-MBID artist.
const FUZZY_THRESHOLD = 88; // fuzz.ratio 0-100; "Nickleback" vs "Nickelback" ≈ 90
const MIN_KEY_LEN = 6; // skip short names — their similarity scores are volatile
const MAX_LEN_DELTA = 2; // candidate name length must be within this many chars
const AMBIGUITY_MARGIN = 5; // best must beat the runner-up by this much

export type AnomalyType = "duplicate_artist";

export interface DuplicateArtistData {
    keepId: string;
    keepName: string;
    keepMbid: string;
    keepAlbums: number;
    keepOwned: number;
    mergeId: string;
    mergeName: string;
    mergeMbid: string;
    mergeAlbums: number;
    mergeOwned: number;
    similarity: number; // 0-100
    matchType: "exact_key" | "fuzzy";
}

export interface Anomaly {
    key: string; // stable id, used to ignore/dismiss
    type: AnomalyType;
    severity: "info" | "warning";
    summary: string;
    suggestedAction: "merge_artists";
    data: DuplicateArtistData;
}

/**
 * Run all detectors and drop anything the admin has chosen to ignore.
 */
export async function detectAnomalies(): Promise<Anomaly[]> {
    const [duplicates, ignoredRows] = await Promise.all([
        detectDuplicateArtists(),
        prisma.anomalyIgnore.findMany({ select: { key: true } }),
    ]);
    const ignored = new Set(ignoredRows.map((r) => r.key));
    return duplicates.filter((a) => !ignored.has(a.key));
}

/**
 * Find temp-MBID artists that match a real-MBID artist, either by exact loose
 * key (punctuation/spacing variants) or by a guarded fuzzy match (typos).
 */
async function detectDuplicateArtists(): Promise<Anomaly[]> {
    const [temps, reals] = await Promise.all([
        prisma.artist.findMany({
            where: { mbid: { startsWith: "temp-" } },
            select: { id: true, name: true, mbid: true },
        }),
        prisma.artist.findMany({
            where: { mbid: { not: { startsWith: "temp-" } } },
            select: { id: true, name: true, mbid: true },
        }),
    ]);
    if (temps.length === 0 || reals.length === 0) return [];

    const realByKey = new Map<string, (typeof reals)[number]>();
    for (const r of reals) {
        const k = looseArtistKey(r.name);
        if (k && !realByKey.has(k)) realByKey.set(k, r);
    }

    // First pass: pick a match per temp artist without touching counts.
    const matches: Array<{
        temp: (typeof temps)[number];
        real: (typeof reals)[number];
        similarity: number;
        matchType: "exact_key" | "fuzzy";
    }> = [];

    for (const temp of temps) {
        const key = looseArtistKey(temp.name);
        if (!key) continue;

        const exact = realByKey.get(key);
        if (exact) {
            matches.push({
                temp,
                real: exact,
                similarity: artistNameSimilarity(temp.name, exact.name),
                matchType: "exact_key",
            });
            continue;
        }

        if (key.length < MIN_KEY_LEN) continue;

        // Guarded fuzzy match: best candidate must clear the threshold AND beat
        // the runner-up by a margin (ambiguity guard), within a length window.
        const tempLen = temp.name.trim().length;
        let best: (typeof reals)[number] | null = null;
        let bestScore = 0;
        let secondScore = 0;
        for (const r of reals) {
            if (Math.abs(r.name.trim().length - tempLen) > MAX_LEN_DELTA) continue;
            const s = artistNameSimilarity(temp.name, r.name);
            if (s > bestScore) {
                secondScore = bestScore;
                bestScore = s;
                best = r;
            } else if (s > secondScore) {
                secondScore = s;
            }
        }
        if (
            best &&
            bestScore >= FUZZY_THRESHOLD &&
            bestScore - secondScore >= AMBIGUITY_MARGIN
        ) {
            matches.push({
                temp,
                real: best,
                similarity: bestScore,
                matchType: "fuzzy",
            });
        }
    }

    if (matches.length === 0) return [];

    // Batch the album/owned counts for every involved artist in two queries.
    const ids = [
        ...new Set(matches.flatMap((m) => [m.temp.id, m.real.id])),
    ];
    const [albumCounts, ownedCounts] = await Promise.all([
        prisma.album.groupBy({
            by: ["artistId"],
            where: { artistId: { in: ids } },
            _count: { _all: true },
        }),
        prisma.ownedAlbum.groupBy({
            by: ["artistId"],
            where: { artistId: { in: ids } },
            _count: { _all: true },
        }),
    ]);
    const albumsBy = new Map(albumCounts.map((c) => [c.artistId, c._count._all]));
    const ownedBy = new Map(ownedCounts.map((c) => [c.artistId, c._count._all]));
    const albums = (id: string) => albumsBy.get(id) ?? 0;
    const owned = (id: string) => ownedBy.get(id) ?? 0;

    return matches.map(({ temp, real, similarity, matchType }) => ({
        key: `duplicate_artist:${temp.id}`,
        type: "duplicate_artist" as const,
        severity: matchType === "fuzzy" ? ("warning" as const) : ("info" as const),
        summary: `Possible duplicate artist: "${temp.name}" ↔ "${real.name}"`,
        suggestedAction: "merge_artists" as const,
        data: {
            keepId: real.id,
            keepName: real.name,
            keepMbid: real.mbid,
            keepAlbums: albums(real.id),
            keepOwned: owned(real.id),
            mergeId: temp.id,
            mergeName: temp.name,
            mergeMbid: temp.mbid,
            mergeAlbums: albums(temp.id),
            mergeOwned: owned(temp.id),
            similarity,
            matchType,
        },
    }));
}
