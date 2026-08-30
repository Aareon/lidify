import { prisma } from "../utils/db";
import { normalizeArtistName } from "../utils/artistNormalization";

/**
 * Choose the better display name for a surviving merged artist. Prefers proper
 * casing and meaningful punctuation, so "J. Cole" wins over "J Cole". On a tie
 * keeps the first argument (the surviving artist's existing name).
 */
export function pickBetterArtistName(current: string, candidate: string): string {
    const score = (n: string) =>
        (/[A-Z]/.test(n) ? 2 : 0) + (/[.\-'&/]/.test(n) ? 1 : 0);
    return score(candidate) > score(current) ? candidate : current;
}

export interface MergeArtistsResult {
    keepId: string;
    keptName: string;
    movedAlbums: number;
    movedOwned: number;
}

/**
 * Merge the `mergeId` artist into the `keepId` artist, atomically:
 *  - moves the merged artist's albums to the survivor,
 *  - migrates OwnedAlbum rows (whose PK is (artistId, rgMbid)), dropping any that
 *    would collide with an existing owned row on the survivor — otherwise the
 *    moved albums would silently lose "owned" status when the merged artist (and
 *    its cascade-linked OwnedAlbum rows) is deleted,
 *  - drops the merged artist's SimilarArtist links (they regenerate),
 *  - deletes the merged artist,
 *  - adopts the better-formatted display name onto the survivor.
 *
 * Shared by the background data-integrity worker (automatic, high-confidence
 * duplicates) and the admin Library Health screen (human-confirmed duplicates).
 * Throws if the ids are equal or either artist is missing.
 */
export async function mergeArtistInto(
    keepId: string,
    mergeId: string
): Promise<MergeArtistsResult> {
    if (keepId === mergeId) {
        throw new Error("Cannot merge an artist into itself");
    }

    const [keep, merge] = await Promise.all([
        prisma.artist.findUnique({
            where: { id: keepId },
            select: { id: true, name: true },
        }),
        prisma.artist.findUnique({
            where: { id: mergeId },
            select: { id: true, name: true },
        }),
    ]);
    if (!keep) throw new Error(`Artist to keep not found: ${keepId}`);
    if (!merge) throw new Error(`Artist to merge not found: ${mergeId}`);

    const bestName = pickBetterArtistName(keep.name, merge.name);

    let movedAlbums = 0;
    let movedOwned = 0;

    await prisma.$transaction(async (tx) => {
        const albums = await tx.album.updateMany({
            where: { artistId: mergeId },
            data: { artistId: keepId },
        });
        movedAlbums = albums.count;

        const keepOwned = await tx.ownedAlbum.findMany({
            where: { artistId: keepId },
            select: { rgMbid: true },
        });
        const keepRgMbids = keepOwned.map((o) => o.rgMbid);
        if (keepRgMbids.length > 0) {
            await tx.ownedAlbum.deleteMany({
                where: { artistId: mergeId, rgMbid: { in: keepRgMbids } },
            });
        }
        const owned = await tx.ownedAlbum.updateMany({
            where: { artistId: mergeId },
            data: { artistId: keepId },
        });
        movedOwned = owned.count;

        await tx.similarArtist.deleteMany({
            where: {
                OR: [{ fromArtistId: mergeId }, { toArtistId: mergeId }],
            },
        });

        await tx.artist.delete({ where: { id: mergeId } });

        if (bestName !== keep.name) {
            await tx.artist.update({
                where: { id: keepId },
                data: {
                    name: bestName,
                    normalizedName: normalizeArtistName(bestName),
                },
            });
        }
    });

    return { keepId, keptName: bestName, movedAlbums, movedOwned };
}
