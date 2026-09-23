import { prisma } from "../utils/db";
import { looseArtistKey, artistNameSimilarity } from "../utils/artistNormalization";

/**
 * Library Health — detects data anomalies an admin can review and remediate on
 * the Settings → Library Health screen. Anomalies are a discriminated union
 * (`type`) so more kinds can be added without changing the transport or the
 * frontend framework. Current detectors:
 *   - duplicate_artist: a placeholder (temp-MBID) row that matches a real-MBID
 *     artist (exact key or guarded fuzzy) → suggest merging.
 *   - missing_mbid: a temp-MBID artist with NO duplicate → never enriched to a
 *     real MusicBrainz ID (limited metadata) → suggest re-enriching.
 *   - unplayable_track: a downloaded track the player reported as failing to
 *     load/play (file missing on disk, or present but undecodable).
 */

// Fuzzy matching thresholds for duplicate detection. Deliberately conservative:
// only temp-MBID rows are ever proposed for merging into a real-MBID artist.
const FUZZY_THRESHOLD = 88; // fuzz.ratio 0-100; "Nickleback" vs "Nickelback" ≈ 90
const MIN_KEY_LEN = 6; // skip short names — their similarity scores are volatile
const MAX_LEN_DELTA = 2; // candidate name length must be within this many chars
const AMBIGUITY_MARGIN = 5; // best must beat the runner-up by this much

export type AnomalyType = "duplicate_artist" | "missing_mbid" | "unplayable_track";

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

export interface MissingMbidData {
    artistId: string;
    artistName: string;
    albums: number;
    owned: number;
}

export interface DuplicateArtistAnomaly {
    key: string;
    type: "duplicate_artist";
    severity: "info" | "warning";
    summary: string;
    suggestedAction: "merge_artists";
    data: DuplicateArtistData;
}

export interface MissingMbidAnomaly {
    key: string;
    type: "missing_mbid";
    severity: "info" | "warning";
    summary: string;
    suggestedAction: "reenrich_artist";
    data: MissingMbidData;
}

export interface UnplayableTrackData {
    trackId: string;
    title: string;
    artistName: string;
    albumTitle: string;
    filePath: string;
    reason: "missing_file" | "playback_error";
    stage: string;
    error: string | null;
    count: number;
    firstAt: string;
    lastAt: string;
}

export interface UnplayableTrackAnomaly {
    key: string;
    type: "unplayable_track";
    severity: "info" | "warning";
    summary: string;
    suggestedAction: "review_file";
    data: UnplayableTrackData;
}

export type Anomaly =
    | DuplicateArtistAnomaly
    | MissingMbidAnomaly
    | UnplayableTrackAnomaly;

type ArtistLite = { id: string; name: string; mbid: string };

/**
 * Run all detectors over a single shared snapshot and drop anything the admin
 * has chosen to ignore.
 */
export async function detectAnomalies(): Promise<Anomaly[]> {
    const [temps, reals, ignoredRows] = await Promise.all([
        prisma.artist.findMany({
            where: { mbid: { startsWith: "temp-" } },
            select: { id: true, name: true, mbid: true },
        }),
        prisma.artist.findMany({
            where: { mbid: { not: { startsWith: "temp-" } } },
            select: { id: true, name: true, mbid: true },
        }),
        prisma.anomalyIgnore.findMany({ select: { key: true } }),
    ]);

    const duplicates = detectDuplicateMatches(temps, reals);
    const coveredTempIds = new Set(duplicates.map((m) => m.temp.id));

    // Temps that aren't part of a duplicate are simply un-enriched (no real MBID).
    const unenriched = temps.filter((t) => !coveredTempIds.has(t.id));

    // Batch album/owned counts for every involved artist in two queries.
    const ids = [
        ...new Set([
            ...duplicates.flatMap((m) => [m.temp.id, m.real.id]),
            ...unenriched.map((t) => t.id),
        ]),
    ];
    const { albums, owned } = await countsFor(ids);

    const dupAnomalies: Anomaly[] = duplicates.map(
        ({ temp, real, similarity, matchType }) => ({
            key: `duplicate_artist:${temp.id}`,
            type: "duplicate_artist",
            severity: matchType === "fuzzy" ? "warning" : "info",
            summary: `Possible duplicate artist: "${temp.name}" ↔ "${real.name}"`,
            suggestedAction: "merge_artists",
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
        })
    );

    const mbidAnomalies: Anomaly[] = unenriched.map((t) => ({
        key: `missing_mbid:${t.id}`,
        type: "missing_mbid",
        severity: "info",
        summary: `"${t.name}" has no MusicBrainz ID — metadata (bio, art, similar artists) is limited`,
        suggestedAction: "reenrich_artist",
        data: {
            artistId: t.id,
            artistName: t.name,
            albums: albums(t.id),
            owned: owned(t.id),
        },
    }));

    const unplayable = await detectUnplayableTracks();

    const ignored = new Set(ignoredRows.map((r) => r.key));
    return [...unplayable, ...dupAnomalies, ...mbidAnomalies].filter(
        (a) => !ignored.has(a.key)
    );
}

/**
 * Downloaded tracks the player reported as unplayable. Rows for tracks that no
 * longer exist (deleted/rescanned away) are pruned here.
 */
async function detectUnplayableTracks(): Promise<Anomaly[]> {
    const failures = await prisma.playbackFailure.findMany({
        orderBy: { lastAt: "desc" },
    });
    if (failures.length === 0) return [];

    const tracks = await prisma.track.findMany({
        where: { id: { in: failures.map((f) => f.trackId) } },
        select: {
            id: true,
            title: true,
            filePath: true,
            album: { select: { title: true, artist: { select: { name: true } } } },
        },
    });
    const trackById = new Map(tracks.map((t) => [t.id, t]));

    const orphaned = failures
        .filter((f) => !trackById.has(f.trackId))
        .map((f) => f.trackId);
    if (orphaned.length > 0) {
        await prisma.playbackFailure
            .deleteMany({ where: { trackId: { in: orphaned } } })
            .catch(() => {});
    }

    return failures.flatMap((f): Anomaly[] => {
        const t = trackById.get(f.trackId);
        if (!t) return [];
        const reason =
            f.reason === "missing_file" ? "missing_file" : "playback_error";
        const artistName = t.album?.artist?.name || "Unknown Artist";
        return [
            {
                key: `unplayable_track:${t.id}`,
                type: "unplayable_track",
                severity: "warning",
                summary:
                    reason === "missing_file"
                        ? `"${t.title}" by ${artistName} can't be played — the file is missing from disk`
                        : `"${t.title}" by ${artistName} failed to play — the file may be corrupt or unsupported`,
                suggestedAction: "review_file",
                data: {
                    trackId: t.id,
                    title: t.title,
                    artistName,
                    albumTitle: t.album?.title || "",
                    filePath: t.filePath,
                    reason,
                    stage: f.stage,
                    error: f.error,
                    count: f.count,
                    firstAt: f.firstAt.toISOString(),
                    lastAt: f.lastAt.toISOString(),
                },
            },
        ];
    });
}

interface DuplicateMatch {
    temp: ArtistLite;
    real: ArtistLite;
    similarity: number;
    matchType: "exact_key" | "fuzzy";
}

/**
 * Match temp-MBID artists to a real-MBID artist by exact loose key
 * (punctuation/spacing variants) or a guarded fuzzy match (typos).
 */
function detectDuplicateMatches(
    temps: ArtistLite[],
    reals: ArtistLite[]
): DuplicateMatch[] {
    if (temps.length === 0 || reals.length === 0) return [];

    const realByKey = new Map<string, ArtistLite>();
    for (const r of reals) {
        const k = looseArtistKey(r.name);
        if (k && !realByKey.has(k)) realByKey.set(k, r);
    }

    const matches: DuplicateMatch[] = [];
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
        let best: ArtistLite | null = null;
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
            matches.push({ temp, real: best, similarity: bestScore, matchType: "fuzzy" });
        }
    }
    return matches;
}

/**
 * Album + owned counts for a set of artist ids, in two grouped queries.
 */
async function countsFor(ids: string[]) {
    if (ids.length === 0) {
        return { albums: () => 0, owned: () => 0 };
    }
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
    return {
        albums: (id: string) => albumsBy.get(id) ?? 0,
        owned: (id: string) => ownedBy.get(id) ?? 0,
    };
}
