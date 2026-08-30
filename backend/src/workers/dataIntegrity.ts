/**
 * Data Integrity Worker
 *
 * Periodic cleanup to maintain database health:
 * 1. Remove expired DiscoverExclusion records
 * 2. Clean up orphaned DiscoveryTrack records
 * 3. Clean up orphaned Album records (DISCOVER location with no DiscoveryAlbum)
 * 4. Consolidate duplicate artists (temp MBID vs real MBID)
 * 5. Clean up orphaned artists (no albums)
 * 6. Clean up old completed/failed DownloadJob records
 * 7. Remove tracks pointing to deleted files (NEW)
 */

import { prisma } from "../utils/db";
import { config } from "../config";
import * as fs from "fs";
import * as path from "path";
import { looseArtistKey } from "../utils/artistNormalization";
import { mergeArtistInto } from "../services/artistMerge";

interface IntegrityReport {
    expiredExclusions: number;
    orphanedDiscoveryTracks: number;
    mislocatedAlbums: number;
    orphanedAlbums: number;
    consolidatedArtists: number;
    orphanedArtists: number;
    oldDownloadJobs: number;
    missingFileTracks: number;
}

export async function runDataIntegrityCheck(): Promise<IntegrityReport> {
    console.log("\nRunning data integrity check...");

    const report: IntegrityReport = {
        expiredExclusions: 0,
        orphanedDiscoveryTracks: 0,
        mislocatedAlbums: 0,
        orphanedAlbums: 0,
        consolidatedArtists: 0,
        orphanedArtists: 0,
        oldDownloadJobs: 0,
        missingFileTracks: 0,
    };

    // 1. Remove expired DiscoverExclusion records
    const expiredExclusions = await prisma.discoverExclusion.deleteMany({
        where: {
            expiresAt: { lt: new Date() },
        },
    });
    report.expiredExclusions = expiredExclusions.count;
    if (expiredExclusions.count > 0) {
        console.log(
            `     Removed ${expiredExclusions.count} expired exclusions`
        );
    }

    // 1.5. Remove tracks pointing to deleted files
    // DISABLED: This check has caused catastrophic data loss multiple times.
    // The check can't reliably determine which base path a track belongs to,
    // especially after database restores or when downloadPath settings are stale.
    // Orphaned tracks are harmless; mass deletion is catastrophic.
    // If file cleanup is needed, user should trigger a full library rescan.
    //
    // Original logic checked: musicPath + downloadPath for each track.filePath
    // But file paths are relative and can't reliably be matched to their source.

    // 2. Clean up orphaned DiscoveryTrack records (tracks whose Track record was deleted)
    const orphanedDiscoveryTracks = await prisma.discoveryTrack.deleteMany({
        where: {
            trackId: null,
        },
    });
    report.orphanedDiscoveryTracks = orphanedDiscoveryTracks.count;
    if (orphanedDiscoveryTracks.count > 0) {
        console.log(
            `     Removed ${orphanedDiscoveryTracks.count} orphaned discovery track records`
        );
    }

    // 3. Clean up orphaned DISCOVER albums (no active DiscoveryAlbum record AND no OwnedAlbum AND no tracks)
    // IMPORTANT: Only delete if album has NO tracks - playlist downloads use DISCOVER location
    // but have no DiscoveryAlbum/OwnedAlbum records, so we must check for tracks
    const discoverAlbums = await prisma.album.findMany({
        where: { location: "DISCOVER" },
        include: { artist: true, _count: { select: { tracks: true } } },
    });

    for (const album of discoverAlbums) {
        // NEVER delete albums that have tracks (could be playlist downloads)
        if (album._count.tracks > 0) continue;

        // Check if there's an ACTIVE, LIKED, or MOVED DiscoveryAlbum record
        const hasActiveRecord = await prisma.discoveryAlbum.findFirst({
            where: {
                OR: [
                    { rgMbid: album.rgMbid },
                    {
                        albumTitle: { equals: album.title, mode: "insensitive" },
                        artistName: { equals: album.artist.name, mode: "insensitive" },
                    },
                ],
                status: { in: ["ACTIVE", "LIKED", "MOVED"] },
            },
        });

        // Also check if there's an OwnedAlbum record (user liked it)
        const hasOwnedRecord = await prisma.ownedAlbum.findFirst({
            where: {
                artistId: album.artistId,
                rgMbid: album.rgMbid,
            },
        });

        if (!hasActiveRecord && !hasOwnedRecord) {
            // Delete album (no tracks, so no cascade needed)
            await prisma.album.delete({
                where: { id: album.id },
            });
            report.orphanedAlbums++;
            console.log(
                `     Removed orphaned album: ${album.artist.name} - ${album.title}`
            );
        }
    }

    // 4. Fix mislocated LIBRARY albums that should be DISCOVER
    // This happens when:
    // - Discovery tracks have featured artists that don't match the download job
    // - Lidarr downloads a different album than requested (e.g., "Broods" album vs "Evergreen" album)
    // - Album title metadata differs from the requested album
    // - Scanner ran before DiscoveryAlbum records were created
    
    const discoveryJobs = await prisma.downloadJob.findMany({
        where: {
            discoveryBatchId: { not: null },
            status: { in: ["pending", "processing", "completed"] },
        },
    });
    
    // Build map of discovery album+artist combos and artist MBIDs (normalized)
    // IMPORTANT: We track album+artist pairs to avoid false positives
    // (e.g., "Above & Beyond - Acoustic" should NOT match "Above - Acoustic")
    const discoveryAlbumArtistPairs = new Set<string>(); // "albumtitle|artistname"
    const discoveryArtistMbids = new Set<string>();

    for (const job of discoveryJobs) {
        const metadata = job.metadata as any;
        const albumTitle = (metadata?.albumTitle || "").toLowerCase().trim();
        const artistName = (metadata?.artistName || "").toLowerCase().trim();
        const artistMbid = metadata?.artistMbid;
        if (albumTitle && artistName) {
            discoveryAlbumArtistPairs.add(`${albumTitle}|${artistName}`);
        }
        if (artistMbid) discoveryArtistMbids.add(artistMbid);
    }

    // Also check DiscoveryAlbum table for ALL discoveries (not just active)
    // This catches albums where Lidarr downloaded a different album than requested
    const allDiscoveryAlbums = await prisma.discoveryAlbum.findMany();
    for (const da of allDiscoveryAlbums) {
        const albumTitle = da.albumTitle.toLowerCase().trim();
        const artistName = da.artistName.toLowerCase().trim();
        discoveryAlbumArtistPairs.add(`${albumTitle}|${artistName}`);
        if (da.artistMbid) discoveryArtistMbids.add(da.artistMbid);
    }
    
    // Find LIBRARY albums that might be discovery
    const libraryAlbums = await prisma.album.findMany({
        where: { location: "LIBRARY" },
        include: { artist: true },
    });
    
    let mislocatedAlbumsFixed = 0;
    for (const album of libraryAlbums) {
        const normalizedTitle = album.title.toLowerCase().trim();
        const normalizedArtist = album.artist.name.toLowerCase().trim();

        // Match criteria (must be specific to avoid false positives):
        // 1. BOTH album title AND artist name match a discovery download, OR
        // 2. Artist MBID matches a discovery download
        // NOTE: We no longer match by title-only or artist-only to prevent
        // false positives like "Above & Beyond - Acoustic" matching "Above - Acoustic"
        const albumAndArtistMatch = discoveryAlbumArtistPairs.has(`${normalizedTitle}|${normalizedArtist}`);
        const artistMbidMatches = album.artist.mbid ? discoveryArtistMbids.has(album.artist.mbid) : false;

        if (!albumAndArtistMatch && !artistMbidMatches) continue;
        
        // KEY FIX: Check if artist has ANY protected OwnedAlbum records:
        // - native_scan = real user library from before discovery
        // - discovery_liked = user liked a discovery album (should be kept!)
        const hasProtectedOwnedAlbum = await prisma.ownedAlbum.findFirst({
            where: {
                artistId: album.artistId,
                source: { in: ["native_scan", "discovery_liked"] },
            },
        });
        
        if (hasProtectedOwnedAlbum) {
            // Artist has protected content - this album should stay as LIBRARY
            continue;
        }
        
        // Also check if artist has any LIKED discovery albums (double-check)
        const hasLikedDiscovery = await prisma.discoveryAlbum.findFirst({
            where: {
                artistMbid: album.artist.mbid || undefined,
                status: { in: ["LIKED", "MOVED"] },
            },
        });
        
        if (hasLikedDiscovery) {
            // User liked albums from this artist - don't touch
            continue;
        }
        
        const reason = albumAndArtistMatch
            ? `album "${album.artist.name} - ${album.title}" matches discovery`
            : `artist MBID matches discovery`;
        console.log(
            `     Fixing mislocated album: ${album.artist.name} - ${album.title} (LIBRARY -> DISCOVER, ${reason})`
        );
        
        // Update album location
        await prisma.album.update({
            where: { id: album.id },
            data: { location: "DISCOVER" },
        });
        
        // Remove OwnedAlbum record (but only non-native ones)
        await prisma.ownedAlbum.deleteMany({
            where: { 
                rgMbid: album.rgMbid,
                source: { not: "native_scan" },
            },
        });
        
        mislocatedAlbumsFixed++;
    }
    
    report.mislocatedAlbums = mislocatedAlbumsFixed;
    if (mislocatedAlbumsFixed > 0) {
        console.log(`     Fixed ${mislocatedAlbumsFixed} mislocated albums`);
    }

    // 5. Clean up albums with NO tracks (files were deleted from filesystem)
    // These are "ghost" albums that still appear in the database but have no actual content
    const emptyAlbums = await prisma.album.findMany({
        where: {
            tracks: { none: {} },
        },
        include: { artist: true },
    });

    for (const album of emptyAlbums) {
        // Delete the album record
        await prisma.album.delete({
            where: { id: album.id },
        });

        // Also delete any associated OwnedAlbum records
        await prisma.ownedAlbum.deleteMany({
            where: { rgMbid: album.rgMbid },
        });

        report.orphanedAlbums++;
        console.log(
            `     Removed empty album (no tracks): ${album.artist.name} - ${album.title}`
        );
    }

    // 6. Clean up orphaned OwnedAlbum records (no matching Album record)
    // This happens when files are deleted but Lidarr records remain
    const orphanedOwnedAlbums = await prisma.$executeRaw`
        DELETE FROM "OwnedAlbum" oa
        WHERE NOT EXISTS (
            SELECT 1 FROM "Album" a WHERE a."rgMbid" = oa."rgMbid"
        )
    `;
    if (orphanedOwnedAlbums > 0) {
        console.log(
            `     Removed ${orphanedOwnedAlbums} orphaned OwnedAlbum records`
        );
    }

    // 7. Consolidate HIGH-CONFIDENCE duplicate artists automatically: a
    // placeholder (temp-MBID) row and a real-MBID row that are the same artist,
    // matched on a punctuation/whitespace-insensitive key (looseArtistKey) so
    // splits differing only by a period or spacing — "J. Cole" vs "J Cole" — are
    // caught. Only EXACT loose-key matches auto-merge here (zero ambiguity);
    // fuzzy/typo duplicates (e.g. "Nickleback" vs "Nickelback") are left for an
    // admin to confirm on the Library Health screen (see services/libraryHealth).
    // The merge itself is the shared, atomic mergeArtistInto() used by both paths.
    const tempArtists = await prisma.artist.findMany({
        where: { mbid: { startsWith: "temp-" } },
        select: { id: true, name: true },
    });

    // Load real-MBID artists once and index them by loose key.
    const realArtists = await prisma.artist.findMany({
        where: { mbid: { not: { startsWith: "temp-" } } },
        select: { id: true, name: true },
    });
    const realByKey = new Map<string, { id: string; name: string }>();
    for (const r of realArtists) {
        const key = looseArtistKey(r.name);
        if (key && !realByKey.has(key)) realByKey.set(key, r);
    }

    for (const tempArtist of tempArtists) {
        const key = looseArtistKey(tempArtist.name);
        if (!key) continue;

        const realArtist = realByKey.get(key);
        if (!realArtist) continue;

        try {
            await mergeArtistInto(realArtist.id, tempArtist.id);
            report.consolidatedArtists++;
            console.log(
                `     Consolidated "${tempArtist.name}" (temp) into "${realArtist.name}" (real MBID)`
            );
        } catch (err) {
            console.error(
                `     Failed to consolidate "${tempArtist.name}":`,
                err
            );
        }
    }

    // 8. Clean up orphaned artists (no albums)
    const orphanedArtists = await prisma.artist.findMany({
        where: {
            albums: { none: {} },
        },
    });

    if (orphanedArtists.length > 0) {
        // Delete SimilarArtist relations first
        await prisma.similarArtist.deleteMany({
            where: {
                OR: [
                    { fromArtistId: { in: orphanedArtists.map((a) => a.id) } },
                    {
                        toArtistId: {
                            in: orphanedArtists.map((a) => a.id),
                        },
                    },
                ],
            },
        });

        // Delete orphaned artists
        await prisma.artist.deleteMany({
            where: { id: { in: orphanedArtists.map((a) => a.id) } },
        });

        report.orphanedArtists = orphanedArtists.length;
    }

    // 9. Clean up old DownloadJob records (older than 30 days, completed/failed)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const oldJobs = await prisma.downloadJob.deleteMany({
        where: {
            status: { in: ["completed", "failed"] },
            completedAt: { lt: thirtyDaysAgo },
        },
    });
    report.oldDownloadJobs = oldJobs.count;
    if (oldJobs.count > 0) {
        console.log(`     Removed ${oldJobs.count} old download jobs`);
    }

    // Summary
    console.log("\nData integrity check complete:");
    console.log(`   - Missing file tracks: ${report.missingFileTracks}`);
    console.log(`   - Expired exclusions: ${report.expiredExclusions}`);
    console.log(
        `   - Orphaned discovery tracks: ${report.orphanedDiscoveryTracks}`
    );
    console.log(`   - Mislocated albums (LIBRARY->DISCOVER): ${report.mislocatedAlbums}`);
    console.log(`   - Orphaned albums: ${report.orphanedAlbums}`);
    console.log(`   - Consolidated artists: ${report.consolidatedArtists}`);
    console.log(`   - Orphaned artists: ${report.orphanedArtists}`);
    console.log(`   - Old download jobs: ${report.oldDownloadJobs}`);

    return report;
}

// CLI entry point
if (require.main === module) {
    runDataIntegrityCheck()
        .then((report) => {
            console.log("\nData integrity check completed successfully");
            process.exit(0);
        })
        .catch((err) => {
            console.error("\n Data integrity check failed:", err);
            process.exit(1);
        });
}
