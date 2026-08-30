/**
 * Smart download policy — background album upgrades via Lidarr.
 *
 * When a per-track download can't be satisfied by Soulseek, we queue a Lidarr
 * grab of the track's whole album in the background so the track is eventually
 * replaced by a proper, tagged file. The track keeps streaming via YouTube in
 * the meantime (it stays "pending"), and the existing scan →
 * reconcilePendingTracks chain performs the upgrade when Lidarr's import lands.
 *
 * Lidarr acquires at album granularity (it can't grab an arbitrary single track
 * out of an album), so one grab covers every missing track from that album —
 * hence the per-album dedup here.
 */

import { prisma } from "../utils/db";
import { lidarrService } from "./lidarr";
import { simpleDownloadManager } from "./simpleDownloadManager";
import { sessionLog } from "../utils/playlistLogger";

export interface AlbumUpgradeResult {
    /**
     * True when Lidarr is (or already was) fetching this album — the caller
     * should leave the track pending/streaming and NOT download from YouTube,
     * so the proper file replaces it on import. False means Lidarr can't help
     * (disabled / album not found) and the caller should fall back to YouTube.
     */
    handled: boolean;
    /** True only when this call created a new grab (vs. reusing an in-flight one). */
    queued: boolean;
    reason?: string;
    jobId?: string;
    album?: string;
}

/** Normalize a title/name for loose comparison. */
function norm(s: string): string {
    return (s || "")
        .toLowerCase()
        .replace(/\(.*?\)|\[.*?\]/g, " ") // drop bracketed qualifiers
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/**
 * Pick the Lidarr album-lookup result that best matches artist + album, or null.
 * Prefers an entry whose album title matches and whose artist matches.
 */
function pickBestAlbum(
    results: any[],
    artistName: string,
    albumTitle: string
): any | null {
    if (!Array.isArray(results) || results.length === 0) return null;
    const wantAlbum = norm(albumTitle);
    const wantArtist = norm(artistName);
    let best: { a: any; score: number; titleMatched: boolean } | null = null;
    for (const a of results) {
        const title = norm(a?.title || "");
        const artist = norm(a?.artist?.artistName || a?.artistName || "");
        if (!a?.foreignAlbumId || !title) continue;
        let score = 0;
        let titleMatched = false;
        if (title === wantAlbum) {
            score += 3;
            titleMatched = true;
        } else if (title.includes(wantAlbum) || wantAlbum.includes(title)) {
            score += 1;
            titleMatched = true;
        }
        if (artist === wantArtist) score += 2;
        else if (artist.includes(wantArtist) || wantArtist.includes(artist)) score += 1;
        if (!best || score > best.score) best = { a, score, titleMatched };
    }
    // REQUIRE a real album-title match (not artist-only) AND a solid total score.
    // Artist match alone (score 2) is not enough — that would grab an arbitrary
    // album by the right artist.
    if (best && best.titleMatched && best.score >= 3) return best.a;
    return null;
}

/**
 * Queue a background Lidarr grab of `albumTitle` by `artistName` for `userId`.
 * Deduped per (user, artist, album): a grab already pending/processing is reused.
 * Best-effort and non-throwing — returns why it did or didn't queue.
 */
export async function queueAlbumUpgrade(
    userId: string,
    artistName: string,
    albumTitle: string
): Promise<AlbumUpgradeResult> {
    try {
        if (!artistName || !albumTitle || albumTitle === "Unknown Album") {
            return { handled: false, queued: false, reason: "insufficient album info" };
        }
        // Callers fall back to the ARTIST name as the album folder when the real
        // album is unknown. We must NOT grab in that case — there's no album to
        // resolve, and matching on artist alone would pull an arbitrary album.
        if (norm(albumTitle) === norm(artistName)) {
            return { handled: false, queued: false, reason: "no real album title (artist name used as album)" };
        }
        if (!(await lidarrService.isEnabled())) {
            return { handled: false, queued: false, reason: "lidarr disabled" };
        }

        const subject = `${artistName} - ${albumTitle}`;

        // Dedup: an in-flight album job for the same subject already covers this.
        const existing = await prisma.downloadJob.findFirst({
            where: {
                userId,
                type: "album",
                subject,
                status: { in: ["pending", "processing"] },
            },
            select: { id: true },
        });
        if (existing) {
            // Another missing track from the same album already triggered a grab.
            return { handled: true, queued: false, reason: "already queued" };
        }

        // Resolve the album to a Lidarr release-group MBID by name.
        const results = await lidarrService
            .searchAlbum(artistName, albumTitle)
            .catch(() => [] as any[]);
        const match = pickBestAlbum(results, artistName, albumTitle);
        if (!match?.foreignAlbumId) {
            return { handled: false, queued: false, reason: "album not found in Lidarr" };
        }
        const rgMbid: string = match.foreignAlbumId;

        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject,
                type: "album",
                targetMbid: rgMbid,
                status: "pending",
                metadata: {
                    downloadType: "library",
                    rootFolderPath: "/music",
                    artistName,
                    albumTitle,
                    // Marks this as a background upgrade for a missing playlist track.
                    reason: "smart-upgrade",
                },
            },
        });

        // Fire the album download in the background (webhook → import → scan →
        // reconcilePendingTracks upgrades the pending track to the proper file).
        simpleDownloadManager
            .startDownload(
                job.id,
                artistName,
                albumTitle,
                rgMbid,
                userId,
                false,
                "/music"
            )
            .catch((err) => {
                console.error(
                    `[AlbumUpgrade] startDownload failed for ${subject}:`,
                    err?.message || err
                );
            });

        sessionLog(
            "ALBUM-UPGRADE",
            `Queued Lidarr album grab: ${subject} (job ${job.id})`
        );
        return { handled: true, queued: true, jobId: job.id, album: subject };
    } catch (err: any) {
        console.error(
            `[AlbumUpgrade] Failed to queue ${artistName} - ${albumTitle}:`,
            err?.message || err
        );
        return { handled: false, queued: false, reason: err?.message || "error" };
    }
}
