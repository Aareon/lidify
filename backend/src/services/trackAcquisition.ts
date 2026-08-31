/**
 * Smart per-track acquisition — the single source of truth for the download
 * pipeline shared by playlist imports and the artist page's "download preview
 * track" button.
 *
 * Pipeline (per track):
 *   1. Soulseek — download the single file. Success → done.
 *   2. Miss → queue a background Lidarr grab of the whole album (deduped per
 *      album). If Lidarr can get it, we're "handled" — the proper file lands
 *      when Lidarr imports (scan → reconcile). See services/albumUpgrade.ts.
 *   3. Lidarr disabled / album not found → YouTube download (yt-dlp).
 *
 * `downloadSubdir` namespaces where files land under the download path
 * (e.g. "Playlists" for imports, "Singles" for standalone track downloads).
 */

import path from "path";
import { soulseekService } from "./soulseek";
import { youtubeMusicService } from "./youtube-music";
import { queueAlbumUpgrade } from "./albumUpgrade";
import { musicBrainzService } from "./musicbrainz";
import { rewriteAudioTags } from "../utils/audioTags";
import { getSystemSettings } from "../utils/systemSettings";

export interface AcquireTrackInput {
    artist: string;
    title: string;
    album?: string | null;
    durationMs?: number;
}

export interface AcquireTrackResult {
    success: boolean;
    source: "soulseek" | "lidarr" | "youtube" | "none";
    filePath?: string;
    error?: string;
}

function sanitizePathPart(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "_").trim();
}

export async function acquireTrackSmart(
    userId: string,
    track: AcquireTrackInput,
    opts: {
        downloadSubdir: string;
        /** Pre-computed usability (batch imports compute once); else derived from settings. */
        soulseekUsable?: boolean;
        youtubeUsable?: boolean;
        /**
         * When true (default), a queued Lidarr album grab counts as "handled" and
         * we stop — the track is expected to arrive via Lidarr's import (playlist
         * behavior: it streams via YouTube meanwhile). When false (single-track
         * "download this now"), the Lidarr grab is still queued as a background
         * bonus, but we ALSO fall through to a YouTube download so the track
         * actually lands even when Lidarr can't get the album.
         */
        lidarrHandledSkipsYouTube?: boolean;
        /**
         * Skip the Lidarr album-grab step entirely (Soulseek → YouTube only).
         * Used by the album-level fallback, where Lidarr has already been tried
         * for the whole album and failed — re-queuing it per track is wasteful.
         */
        skipLidarr?: boolean;
    }
): Promise<AcquireTrackResult> {
    const settings = await getSystemSettings();
    const musicPath = settings?.musicPath || "/music";
    const downloadBase = settings?.downloadPath || "/soulseek-downloads";
    // Fall back to the artist name as the folder when the album is unknown.
    const albumFolder =
        track.album && track.album !== "Unknown Album"
            ? track.album
            : track.artist;

    const soulseekUsable =
        opts.soulseekUsable ??
        Boolean(
            settings?.soulseekEnabled !== false &&
                settings?.soulseekUsername &&
                settings?.soulseekPassword &&
                (await soulseekService.isAvailable())
        );
    const youtubeUsable = opts.youtubeUsable ?? settings?.youtubeEnabled !== false;

    // 1) Soulseek — proper single file.
    if (soulseekUsable) {
        try {
            const searchResult = await soulseekService.searchTrack(
                track.artist,
                track.title,
                false,
                {
                    preferFlac: true,
                    allowMp3320Fallback: true,
                    allowMp3256Fallback: true,
                    timeoutMs: 3500,
                }
            );
            if (searchResult.found && searchResult.allMatches.length > 0) {
                const dl = await soulseekService.downloadBestMatch(
                    track.artist,
                    track.title,
                    albumFolder,
                    searchResult.allMatches,
                    musicPath,
                    { downloadSubdir: opts.downloadSubdir }
                );
                if (dl.success) {
                    return { success: true, source: "soulseek", filePath: dl.filePath };
                }
            }
        } catch {
            // fall through to the smart upgrade / YouTube
        }
    }

    // 2) Smart upgrade: queue a background Lidarr album grab (deduped per album).
    if (!opts.skipLidarr) {
        const upgrade = await queueAlbumUpgrade(userId, track.artist, albumFolder);
        if (upgrade.handled && opts.lidarrHandledSkipsYouTube !== false) {
            return { success: true, source: "lidarr" };
        }
    }
    // Otherwise the Lidarr grab (if any) runs in the background and we still fall
    // through to YouTube so the track lands now.

    // 3) YouTube fallback.
    if (!youtubeUsable) {
        return {
            success: false,
            source: "none",
            error: "Soulseek failed and YouTube is disabled",
        };
    }
    const durationSeconds = track.durationMs
        ? Math.round(track.durationMs / 1000)
        : undefined;
    const match = await youtubeMusicService.findTrack(
        track.artist,
        track.title,
        durationSeconds,
        albumFolder
    );
    if (!match?.videoId) {
        return { success: false, source: "youtube", error: "No YouTube match found" };
    }
    const outputDir = path.join(
        downloadBase,
        opts.downloadSubdir,
        sanitizePathPart(track.artist),
        sanitizePathPart(albumFolder)
    );
    const filename = `${sanitizePathPart(track.artist)} - ${sanitizePathPart(
        track.title
    )} - ${match.videoId}`;
    try {
        const dl = await youtubeMusicService.downloadTrack(
            match.videoId,
            outputDir,
            filename
        );
        try {
            await rewriteAudioTags(dl.filePath, {
                title: track.title,
                artist: track.artist,
                album: albumFolder,
            });
        } catch {
            // Tagging improves reconcile reliability but isn't required for scan.
        }
        return { success: true, source: "youtube", filePath: dl.filePath };
    } catch (err: any) {
        return {
            success: false,
            source: "youtube",
            error: err?.message || "YouTube download failed",
        };
    }
}

export interface AcquireAlbumResult {
    total: number;
    landed: number;
    // Per-source tally of the tracks that landed, for the completion notice.
    sources: { soulseek: number; youtube: number };
}

/**
 * Album-level fallback for when Lidarr can't fulfill a whole-album download.
 * Fetches the album's MusicBrainz tracklist and runs the per-track smart
 * pipeline (Soulseek → YouTube; Lidarr is skipped because it already failed for
 * this album) for each track. Files land under `<downloadSubdir>/<artist>/<album>`
 * so a subsequent library scan folds them into the album. Sequential on purpose
 * — parallel Soulseek/yt-dlp would hammer both engines.
 */
export async function acquireAlbumSmart(
    userId: string,
    album: { artist: string; album: string; rgMbid: string },
    opts: { downloadSubdir: string }
): Promise<AcquireAlbumResult> {
    const result: AcquireAlbumResult = {
        total: 0,
        landed: 0,
        sources: { soulseek: 0, youtube: 0 },
    };

    let mbTracks: Array<{ title: string; lengthMs: number | null }> = [];
    try {
        mbTracks = await musicBrainzService.getAlbumTracklist(album.rgMbid);
    } catch {
        mbTracks = [];
    }
    result.total = mbTracks.length;
    if (mbTracks.length === 0) return result;

    for (const mb of mbTracks) {
        if (!mb.title) continue;
        try {
            const r = await acquireTrackSmart(
                userId,
                {
                    artist: album.artist,
                    title: mb.title,
                    album: album.album,
                    durationMs: mb.lengthMs ?? undefined,
                },
                {
                    downloadSubdir: opts.downloadSubdir,
                    skipLidarr: true, // Lidarr already failed for this album
                    lidarrHandledSkipsYouTube: false,
                }
            );
            if (r.success && r.source === "soulseek") {
                result.landed++;
                result.sources.soulseek++;
            } else if (r.success && r.source === "youtube") {
                result.landed++;
                result.sources.youtube++;
            }
        } catch {
            // Skip a track that errors; keep going through the rest of the album.
        }
    }

    return result;
}
