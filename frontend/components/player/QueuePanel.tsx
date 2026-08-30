"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import {
    ListMusic,
    X,
    Play,
    Pause,
    Trash2,
    ChevronUp,
    ChevronDown,
    Music,
} from "lucide-react";
import { useAudio } from "@/lib/audio-context";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";

/**
 * Slide-over panel to view and edit the play queue. Opened from any player
 * variant by dispatching a `toggle-queue-panel` (or `open-queue-panel`) window
 * event — the same pattern the app uses for its other panels. Rendered once, at
 * the player mount point (UniversalPlayer).
 */
export function QueuePanel() {
    const {
        queue,
        currentTrack,
        currentIndex,
        isPlaying,
        playTracks,
        removeFromQueue,
        clearQueue,
        pause,
        resume,
    } = useAudio();
    const [isOpen, setIsOpen] = useState(false);

    // Open/close via window events (dispatched by the player buttons).
    useEffect(() => {
        const toggle = () => setIsOpen((o) => !o);
        const open = () => setIsOpen(true);
        const close = () => setIsOpen(false);
        window.addEventListener("toggle-queue-panel", toggle);
        window.addEventListener("open-queue-panel", open);
        window.addEventListener("close-queue-panel", close);
        return () => {
            window.removeEventListener("toggle-queue-panel", toggle);
            window.removeEventListener("open-queue-panel", open);
            window.removeEventListener("close-queue-panel", close);
        };
    }, []);

    // Close on Escape.
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setIsOpen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [isOpen]);

    const nextTracks = queue.slice(currentIndex + 1);

    const fmt = (secs?: number) => {
        if (!secs && secs !== 0) return "";
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m}:${s.toString().padStart(2, "0")}`;
    };

    // Reorder within the "next up" region; never move past the current track.
    const move = (fromIdx: number, dir: -1 | 1) => {
        const toIdx = fromIdx + dir;
        if (toIdx <= currentIndex || toIdx >= queue.length) return;
        const next = [...queue];
        [next[fromIdx], next[toIdx]] = [next[toIdx], next[fromIdx]];
        playTracks(next, currentIndex);
    };

    const playFrom = (index: number) => playTracks(queue, index);

    return (
        <>
            {/* Backdrop */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-[100] transition-opacity"
                    onClick={() => setIsOpen(false)}
                    aria-hidden
                />
            )}

            {/* Drawer: full-width sheet on mobile, right-side panel on desktop */}
            <div
                className={cn(
                    "fixed inset-y-0 right-0 z-[101] w-full sm:w-[400px] bg-[#0d0d0d] border-l border-white/10",
                    "flex flex-col shadow-2xl transition-transform duration-300 ease-out",
                    isOpen ? "translate-x-0" : "translate-x-full"
                )}
                role="dialog"
                aria-label="Play queue"
                style={{
                    paddingTop: "env(safe-area-inset-top)",
                    paddingBottom: "env(safe-area-inset-bottom)",
                }}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
                    <div className="flex items-center gap-2.5">
                        <ListMusic className="w-5 h-5 text-brand" />
                        <div>
                            <h2 className="text-base font-semibold text-white leading-none">
                                Queue
                            </h2>
                            <p className="text-xs text-gray-500 mt-1">
                                {nextTracks.length} up next
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        {queue.length > 0 && (
                            <button
                                onClick={() => clearQueue()}
                                className="p-2 rounded-full text-gray-400 hover:text-red-400 hover:bg-white/5 transition-colors"
                                title="Clear queue"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        )}
                        <button
                            onClick={() => setIsOpen(false)}
                            className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                            aria-label="Close queue"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto">
                    {queue.length === 0 && (
                        <div className="flex flex-col items-center justify-center text-center py-20 px-6">
                            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-3">
                                <ListMusic className="w-8 h-8 text-gray-600" />
                            </div>
                            <p className="text-sm text-gray-400">
                                Your queue is empty
                            </p>
                            <p className="text-xs text-gray-600 mt-1">
                                Play something to see it here
                            </p>
                        </div>
                    )}

                    {/* Now playing */}
                    {currentTrack && (
                        <div className="px-4 pt-4">
                            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
                                Now Playing
                            </div>
                            <div className="flex items-center gap-3 p-2 rounded-lg bg-brand/10 border border-brand/20">
                                <TrackArt track={currentTrack} size={44} />
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-brand truncate">
                                        {currentTrack.title}
                                    </p>
                                    <p className="text-xs text-gray-400 truncate">
                                        {currentTrack.artist?.name}
                                    </p>
                                </div>
                                <button
                                    onClick={() =>
                                        isPlaying ? pause() : resume()
                                    }
                                    className="p-2 rounded-full text-white hover:bg-white/10 transition-colors"
                                    aria-label={isPlaying ? "Pause" : "Play"}
                                >
                                    {isPlaying ? (
                                        <Pause className="w-4 h-4 fill-current" />
                                    ) : (
                                        <Play className="w-4 h-4 fill-current" />
                                    )}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Next up */}
                    {nextTracks.length > 0 && (
                        <div className="px-4 py-4">
                            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
                                Next Up
                            </div>
                            <div className="space-y-0.5">
                                {nextTracks.map((track, idx) => {
                                    const queueIndex = currentIndex + 1 + idx;
                                    return (
                                        <div
                                            key={`${track.id}-${queueIndex}`}
                                            className="group flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 transition-colors"
                                        >
                                            <button
                                                onClick={() =>
                                                    playFrom(queueIndex)
                                                }
                                                className="relative shrink-0"
                                                title="Play now"
                                            >
                                                <TrackArt track={track} size={40} />
                                                <span className="absolute inset-0 flex items-center justify-center rounded-md bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <Play className="w-4 h-4 text-white fill-current" />
                                                </span>
                                            </button>
                                            <div
                                                className="flex-1 min-w-0 cursor-pointer"
                                                onClick={() =>
                                                    playFrom(queueIndex)
                                                }
                                            >
                                                <p className="text-sm text-white truncate">
                                                    {track.title}
                                                </p>
                                                <p className="text-xs text-gray-400 truncate">
                                                    {track.artist?.name}
                                                </p>
                                            </div>
                                            <span className="text-[11px] text-gray-600 tabular-nums hidden sm:block">
                                                {fmt(track.duration)}
                                            </span>
                                            {/* Edit controls */}
                                            <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={() =>
                                                        move(queueIndex, -1)
                                                    }
                                                    disabled={
                                                        queueIndex <=
                                                        currentIndex + 1
                                                    }
                                                    className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                                                    title="Move up"
                                                >
                                                    <ChevronUp className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        move(queueIndex, 1)
                                                    }
                                                    disabled={
                                                        queueIndex >=
                                                        queue.length - 1
                                                    }
                                                    className="p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                                                    title="Move down"
                                                >
                                                    <ChevronDown className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() =>
                                                        removeFromQueue(
                                                            queueIndex
                                                        )
                                                    }
                                                    className="p-1.5 rounded-md text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                                    title="Remove from queue"
                                                >
                                                    <X className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {currentTrack && nextTracks.length === 0 && (
                        <p className="text-center text-xs text-gray-600 py-8">
                            Nothing up next
                        </p>
                    )}
                </div>
            </div>
        </>
    );
}

interface TrackLike {
    title: string;
    album?: { coverArt?: string | null; title?: string } | null;
    artist?: { name?: string } | null;
}

function TrackArt({ track, size }: { track: TrackLike; size: number }) {
    const cover = track.album?.coverArt;
    return (
        <div
            className="relative rounded-md overflow-hidden bg-[#181818] shrink-0"
            style={{ width: size, height: size }}
        >
            {cover ? (
                <Image
                    src={api.getCoverArtUrl(cover, 100)}
                    alt={track.album?.title || track.title}
                    fill
                    unoptimized
                    className="object-cover"
                    sizes="44px"
                />
            ) : (
                <div className="w-full h-full flex items-center justify-center">
                    <Music className="w-5 h-5 text-gray-600" />
                </div>
            )}
        </div>
    );
}
