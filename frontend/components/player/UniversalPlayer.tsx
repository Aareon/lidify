"use client";

import { useAudio } from "@/lib/audio-context";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { MiniPlayer } from "./MiniPlayer";
import { FullPlayer } from "./FullPlayer";
import { OverlayPlayer } from "./OverlayPlayer";
import { QueuePanel } from "./QueuePanel";

/**
 * UniversalPlayer - Manages player UI rendering based on mode and device
 * NOTE: The AudioElement is rendered by ConditionalAudioProvider, NOT here
 * This component only handles the UI (MiniPlayer, FullPlayer, OverlayPlayer)
 *
 * Mobile/Tablet behavior:
 * - Shows mini player at bottom (user can tap to open overlay)
 * - No full-width player on mobile
 */
export function UniversalPlayer() {
    const { playerMode, currentTrack, currentAudiobook, currentPodcast } =
        useAudio();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast);

    return (
        <>
            {/* Conditional UI rendering based on mode and device */}
            {/* Note: AudioElement is rendered by ConditionalAudioProvider */}
            {/* Always show player UI (like Spotify), even when no media is playing */}
            {playerMode === "overlay" && hasMedia ? (
                <OverlayPlayer />
            ) : isMobileOrTablet ? (
                /* On mobile/tablet: only mini player (no full player) */
                <MiniPlayer />
            ) : (
                /* Desktop: always show full-width bottom player */
                <FullPlayer />
            )}

            {/* View/edit queue drawer — opened by the queue button on any player
                variant via the `toggle-queue-panel` window event. */}
            <QueuePanel />
        </>
    );
}
