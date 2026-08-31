import { useState, useRef, useEffect } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Track } from "../types";
import { useAudio } from "@/lib/audio-context";

interface PreviewAlbumInfo {
    title: string;
    cover: string | null;
}

interface UsePreviewPlayerOptions {
    artistName?: string;
    tracks?: Track[];
}

/** Synthetic id prefix for a preview loaded into the main player. */
const PREVIEW_PREFIX = "preview-";

/**
 * Plays 30s Deezer previews THROUGH the main player (as a synthetic track whose
 * source is the preview URL). This means the preview shows in the player with
 * progress + play/pause, and can never play "on top of" a real track — the
 * player only plays one thing at a time.
 */
export function usePreviewPlayer(options: UsePreviewPlayerOptions = {}) {
    const { artistName, tracks } = options;
    const { currentTrack, isPlaying, playTracks, pause, resume } = useAudio();

    const [previewAlbumInfo, setPreviewAlbumInfo] = useState<
        Record<string, PreviewAlbumInfo>
    >({});
    const [noPreviewTracks, setNoPreviewTracks] = useState<Set<string>>(
        new Set()
    );
    const previewRequestIdRef = useRef(0);
    const noPreviewTrackIdsRef = useRef<Set<string>>(new Set());
    const toastShownForNoPreviewRef = useRef<Set<string>>(new Set());
    const inFlightTrackIdRef = useRef<string | null>(null);

    // Which original track (if any) is currently loaded in the player as a preview.
    const previewTrack =
        currentTrack?.id && currentTrack.id.startsWith(PREVIEW_PREFIX)
            ? currentTrack.id.slice(PREVIEW_PREFIX.length)
            : null;
    const previewPlaying = previewTrack !== null && isPlaying;

    const showNoPreviewToast = (trackId: string) => {
        if (toastShownForNoPreviewRef.current.has(trackId)) return;
        toastShownForNoPreviewRef.current.add(trackId);
        toast("No Deezer preview available", { duration: 1500 });
    };

    async function handlePreview(
        track: Track,
        artistNameArg: string,
        e: React.MouseEvent
    ) {
        e.stopPropagation();
        const previewId = `${PREVIEW_PREFIX}${track.id}`;

        // If this preview is already the current player track, toggle play/pause.
        if (currentTrack?.id === previewId) {
            if (isPlaying) pause();
            else resume();
            return;
        }

        if (inFlightTrackIdRef.current === track.id) return;
        if (noPreviewTrackIdsRef.current.has(track.id)) {
            showNoPreviewToast(track.id);
            return;
        }

        try {
            const requestId = ++previewRequestIdRef.current;
            inFlightTrackIdRef.current = track.id;

            const response = await api.getTrackPreview(artistNameArg, track.title);
            if (requestId !== previewRequestIdRef.current) return;

            if (!response.previewUrl) {
                noPreviewTrackIdsRef.current.add(track.id);
                showNoPreviewToast(track.id);
                return;
            }

            // Cache the Deezer album info for the row + player display.
            const albumTitle =
                response.albumTitle ||
                (track.album?.title && track.album.title !== "Unknown Album"
                    ? track.album.title
                    : "");
            const albumCover = response.albumCover || track.album?.coverArt || null;
            if (response.albumTitle) {
                setPreviewAlbumInfo((prev) => ({
                    ...prev,
                    [track.id]: {
                        title: response.albumTitle!,
                        cover: response.albumCover || null,
                    },
                }));
            }

            // Play the preview through the main player as a one-off track.
            playTracks(
                [
                    {
                        id: previewId,
                        title: track.title,
                        artist: { name: artistNameArg },
                        album: {
                            title: albumTitle,
                            coverArt: albumCover || undefined,
                        },
                        duration: 30, // Deezer previews are 30 seconds
                        previewUrl: response.previewUrl,
                    },
                ],
                0
            );
        } catch (error: unknown) {
            const message =
                typeof error === "object" && error !== null
                    ? String(
                          (error as Record<string, unknown>).error ||
                              (error as Record<string, unknown>).message ||
                              ""
                      )
                    : "";
            if (/preview not found/i.test(message)) {
                noPreviewTrackIdsRef.current.add(track.id);
                showNoPreviewToast(track.id);
                return;
            }
            toast.error("Failed to load preview");
            console.error("Preview error:", error);
        } finally {
            if (inFlightTrackIdRef.current === track.id) {
                inFlightTrackIdRef.current = null;
            }
        }
    }

    // Prefetch album info for unowned tracks (runs once after page load)
    useEffect(() => {
        if (!artistName || !tracks || tracks.length === 0) return;

        const unownedTracks = tracks.filter((track) => {
            const isUnowned =
                !track.album?.id ||
                !track.album?.title ||
                track.album.title === "Unknown Album";
            const alreadyFetched = previewAlbumInfo[track.id];
            return isUnowned && !alreadyFetched;
        });

        if (unownedTracks.length === 0) return;

        const prefetchAlbumInfo = async () => {
            for (const track of unownedTracks.slice(0, 5)) {
                try {
                    const response = await api.getTrackPreview(
                        artistName,
                        track.title
                    );
                    if (response.albumTitle) {
                        setPreviewAlbumInfo((prev) => ({
                            ...prev,
                            [track.id]: {
                                title: response.albumTitle!,
                                cover: response.albumCover || null,
                            },
                        }));
                    } else {
                        setNoPreviewTracks((prev) =>
                            new Set(prev).add(track.id)
                        );
                        noPreviewTrackIdsRef.current.add(track.id);
                    }
                } catch {
                    setNoPreviewTracks((prev) => new Set(prev).add(track.id));
                    noPreviewTrackIdsRef.current.add(track.id);
                }
                await new Promise((r) => setTimeout(r, 100));
            }
        };

        const timeoutId = setTimeout(prefetchAlbumInfo, 500);
        return () => clearTimeout(timeoutId);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- previewAlbumInfo is populated by this effect, not a dependency
    }, [artistName, tracks]);

    return {
        previewTrack,
        previewPlaying,
        previewAlbumInfo,
        noPreviewTracks,
        handlePreview,
    };
}
