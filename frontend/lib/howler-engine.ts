/**
 * Howler.js Audio Engine
 *
 * Singleton manager for audio playback using Howler.js
 * Handles: play, pause, seek, volume, track changes, events
 */

import { Howl, type HowlOptions } from "howler";

export type HowlerEventType =
    | "play"
    | "pause"
    | "stop"
    | "end"
    | "seek"
    | "volume"
    | "load"
    | "loaderror"
    | "playerror"
    | "timeupdate"
    // Emitted when the engine advances to a preloaded next track on its own
    // (gapless / background-safe advancement), so React can sync its pointer.
    | "trackadvanced";

export type HowlerEventCallback = (data?: unknown) => void;

interface HowlerEngineState {
    currentSrc: string | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    volume: number;
    isMuted: boolean;
}

interface HowlInternal extends Howl {
    _sounds?: Array<{ _node?: HTMLMediaElement }>;
    _format?: string[];
}

class HowlerEngine {
    private howl: Howl | null = null;
    private timeUpdateInterval: NodeJS.Timeout | null = null;
    private eventListeners: Map<HowlerEventType, Set<HowlerEventCallback>> =
        new Map();
    private state: HowlerEngineState = {
        currentSrc: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: 1,
        isMuted: false,
    };
    private isLoading: boolean = false; // Guard against duplicate loads
    private userInitiatedPlay: boolean = false; // Track if play was user-initiated
    private pendingPlay: boolean = false; // Guard against multiple play() calls before audio starts
    private isChangingTrack: boolean = false; // Suppress errors during track changes
    private retryCount: number = 0; // Track retry attempts
    private maxRetries: number = 3; // Max retry attempts for load errors
    private pendingAutoplay: boolean = false; // Track pending autoplay for retries
    private lastFormat: string | undefined; // Store format for retries
    private readonly popFadeMs: number = 10; // ms - micro-fade to reduce click/pop on track changes
    private shouldRetryLoads: boolean = false; // Only retry transient load errors where it helps (Android WebView)
    private cleanupTimeoutId: NodeJS.Timeout | null = null; // Track cleanup timeout to prevent race conditions
    
    // Seek state management - prevents stale timeupdate events during seeks
    private isSeeking: boolean = false;
    private seekTargetTime: number | null = null;
    private seekTimeoutId: NodeJS.Timeout | null = null;

    // Preloaded next track (for gapless + background-safe advancement).
    // While the current track plays, we fetch the next one into a second Howl so
    // that when the current ends we can promote+play it imperatively inside the
    // engine's own "end" callback — without waiting on a React re-render, which
    // Android throttles to a halt when the PWA is backgrounded / screen off.
    private nextHowl: Howl | null = null;
    private nextSrc: string | null = null;
    private nextFormat: string | undefined;
    private nextTrackId: string | null = null;

    constructor() {
        // Initialize event listener maps
        const events: HowlerEventType[] = [
            "play",
            "pause",
            "stop",
            "end",
            "seek",
            "volume",
            "load",
            "loaderror",
            "playerror",
            "timeupdate",
            "trackadvanced",
        ];
        events.forEach((event) => this.eventListeners.set(event, new Set()));
    }

    /**
     * Load and optionally play a new audio source
     * @param src - Audio URL
     * @param autoplay - Whether to auto-play after loading
     * @param format - Audio format hint (mp3, flac, etc.) - required for URLs without extensions
     */
    load(
        src: string,
        autoplay: boolean = false,
        format?: string,
        isRetry: boolean = false
    ): void {
        // Don't reload if same source and already loaded
        if (this.state.currentSrc === src && this.howl) {
            if (autoplay && !this.state.isPlaying) {
                this.play();
            }
            return;
        }

        // Prevent duplicate loads - if already loading this URL, skip
        if (this.isLoading && this.state.currentSrc === src) {
            return;
        }

        // A fresh load (manual skip, new queue, etc.) supersedes any preloaded
        // next track — it may no longer be the right one. Preloading is only used
        // by the autonomous end-of-track advance (handleActiveEnd), which is the
        // path that must survive the PWA being backgrounded; manual loads take the
        // normal async path here. cleanup() also clears the preload defensively.
        this.clearPreload();

        // Set loading guard immediately
        this.isLoading = true;

        // Simple instant switch - no crossfade (crossfade caused duplicate playback bugs)
        // Just stop current track and load new one
        this.cleanup();

        this.state.currentSrc = src;

        // On Android WebView, retry transient load errors (see createHowl).
        this.shouldRetryLoads = this.isAndroidWebView();

        // Store for potential retry
        this.pendingAutoplay = autoplay;
        this.lastFormat = format;
        // Reset retry count only when this is NOT a retry attempt.
        // If we reset on retries, we can end up in an infinite retry loop.
        if (!isRetry) {
            this.retryCount = 0;
        }

        console.log(`[HowlerEngine] Creating new Howl instance for: ${src.substring(0, 80)}...`);

        // Build and activate the Howl. autoplay is honored inside onload.
        this.createHowl(src, format, autoplay, "active");
    }

    /**
     * Detect Android System WebView (embedded in a native app). A browser's own
     * PWA / standalone context is NOT a WebView and does not match here.
     */
    private isAndroidWebView(): boolean {
        return (
            typeof navigator !== "undefined" &&
            /wv/.test(navigator.userAgent.toLowerCase()) &&
            /android/.test(navigator.userAgent.toLowerCase())
        );
    }

    /**
     * Build the Howl options shared by the active track and the preloaded next
     * track. HTML5 Audio is used except on Android WebView for music (where it
     * caused crackling); podcasts/audiobooks always use HTML5 for Range/seek.
     */
    private buildHowlConfig(src: string, format?: string): HowlOptions {
        const isAndroidWebView = this.isAndroidWebView();
        const isPodcastOrAudiobook =
            src.includes("/api/podcasts/") || src.includes("/api/audiobooks/");

        const config = {
            src: [src],
            html5: isPodcastOrAudiobook || !isAndroidWebView, // HTML5 for podcasts/audiobooks OR non-Android
            autoplay: false, // We'll handle autoplay manually
            preload: true,
            volume: this.state.isMuted ? 0 : this.state.volume,
            pool: 1, // Only allow one sound instance to prevent echo/double playback
            // On Android WebView, increase the xhr timeout
            ...(isAndroidWebView && { xhr: { timeout: 30000 } }),
        } as HowlOptions;

        // Add format hints (required for URLs without file extensions)
        if (format) {
            const formats = [format];
            if (!formats.includes("mp3")) formats.push("mp3");
            if (!formats.includes("flac")) formats.push("flac");
            if (!formats.includes("mp4")) formats.push("mp4");
            if (!formats.includes("webm")) formats.push("webm");
            config.format = formats;
        } else {
            config.format = ["mp3", "flac", "mp4", "webm", "wav"];
        }

        return config;
    }

    /**
     * Create a Howl for either the active track or the preloaded next track.
     * Every callback that mutates current-playback state is guarded with
     * `this.howl !== howl`, so a preloaded (inactive) instance can never disturb
     * the track that is currently playing. When a preloaded instance is later
     * promoted (this.howl = it), those same callbacks light up for it.
     */
    private createHowl(
        src: string,
        format: string | undefined,
        autoplay: boolean,
        role: "active" | "preload"
    ): Howl {
        const config = this.buildHowlConfig(src, format);

        const howl = new Howl({
            ...config,
            onload: () => {
                if (this.howl !== howl) {
                    // Preloaded instance finished fetching; stays inert until promoted.
                    return;
                }
                console.log(`[HowlerEngine] Loaded: ${this.state.currentSrc?.substring(0, 80)}...`);
                this.isLoading = false;
                this.isChangingTrack = false; // Clear flag only after successful load
                this.state.duration = this.howl?.duration() || 0;
                this.emit("load", { duration: this.state.duration });

                if (autoplay) {
                    this.play();
                }
            },
            onloaderror: (id, error) => {
                if (this.howl !== howl) {
                    // A preloaded next track failed to fetch. Discard it and keep the
                    // current track playing; advancement falls back to a normal load.
                    console.warn("[HowlerEngine] Preloaded next track failed to load; discarding");
                    if (this.nextHowl === howl) this.clearPreload();
                    return;
                }
                console.error(
                    "[HowlerEngine] Load error:",
                    error,
                    "Attempt:",
                    this.retryCount + 1
                );
                this.isLoading = false;

                // Retry logic for transient errors (common on Android WebView)
                if (
                    this.shouldRetryLoads &&
                    this.retryCount < this.maxRetries &&
                    this.state.currentSrc
                ) {
                    this.retryCount++;
                    console.log(
                        `[HowlerEngine] Retrying load (attempt ${this.retryCount}/${this.maxRetries})...`
                    );

                    // Save src before cleanup
                    const srcToRetry = this.state.currentSrc;
                    const autoplayToRetry = this.pendingAutoplay;
                    const formatToRetry = this.lastFormat;

                    // CRITICAL: Clean up the failed Howl instance BEFORE retrying
                    // This prevents "HTML5 Audio pool exhausted" errors
                    this.cleanup();

                    // Wait a bit before retrying
                    setTimeout(() => {
                        this.load(
                            srcToRetry,
                            autoplayToRetry,
                            formatToRetry,
                            true
                        );
                    }, 500 * this.retryCount); // Exponential backoff
                    return;
                }

                // All retries failed - clean up and emit error
                this.retryCount = 0;
                this.isChangingTrack = false; // Clear flag on load error
                this.cleanup(); // Clean up failed instance
                this.emit("loaderror", { error });
            },
            onplayerror: (id, error) => {
                if (this.howl !== howl) return;
                // Ignore errors during track changes - they're stale from the old Howl
                if (this.isChangingTrack) {
                    console.log("[HowlerEngine] Ignoring play error during track change");
                    return;
                }

                console.error("[HowlerEngine] Play error:", error);
                // Clear playing state so UI shows play button
                this.state.isPlaying = false;
                this.pendingPlay = false; // Clear pending flag - play failed
                this.userInitiatedPlay = false;
                this.stopTimeUpdates();
                this.emit("playerror", { error });
                // Don't try to auto-recover - let the user click play again
            },
            onplay: () => {
                if (this.howl !== howl) return;
                const sounds = this.getInternalHowl()?._sounds;
                console.log(
                    `[HowlerEngine] onplay event fired, sounds count: ${sounds?.length || 0}`
                );
                this.state.isPlaying = true;
                this.pendingPlay = false; // Clear pending flag - play succeeded
                this.userInitiatedPlay = false; // Clear flag after successful play
                this.startTimeUpdates();
                this.emit("play");
            },
            onpause: () => {
                if (this.howl !== howl) return;
                this.state.isPlaying = false;
                this.pendingPlay = false; // Clear pending flag
                this.userInitiatedPlay = false;
                this.stopTimeUpdates();
                this.emit("pause");
            },
            onstop: () => {
                if (this.howl !== howl) return;
                this.state.isPlaying = false;
                this.pendingPlay = false; // Clear pending flag
                this.state.currentTime = 0;
                this.stopTimeUpdates();
                this.emit("stop");
            },
            onend: () => {
                if (this.howl !== howl) return;
                this.handleActiveEnd();
            },
            onseek: () => {
                if (this.howl !== howl) return;
                this.state.currentTime = this.howl.seek() as number;
                this.emit("seek", { time: this.state.currentTime });
            },
        });

        // Assign synchronously so the guards above resolve correctly. Howler fires
        // these callbacks asynchronously, so this runs before any of them.
        if (role === "active") {
            this.howl = howl;
        } else {
            this.nextHowl = howl;
        }

        return howl;
    }

    /**
     * Handle the active track reaching its end. If a next track has been
     * preloaded, promote and play it right here (no React round-trip, so it works
     * when the PWA is backgrounded); otherwise emit "end" for React to advance.
     */
    private handleActiveEnd(): void {
        this.state.isPlaying = false;
        this.stopTimeUpdates();

        if (this.nextHowl && this.nextSrc) {
            // Autonomous advance (track ended on its own). Promote+play the
            // preloaded track, then tell React to sync its queue pointer.
            const advancedTrackId = this.promoteNextAsActive(true);
            this.emit("trackadvanced", { trackId: advancedTrackId });
        } else {
            this.emit("end");
        }
    }

    /**
     * Promote the preloaded next Howl to the active track and (optionally) play
     * it immediately. Returns the promoted track id. Does NOT emit
     * "trackadvanced" — the caller decides whether React needs to sync (it does
     * for an autonomous end-of-track advance, but not for a React-driven load()
     * promotion where React already knows the current track).
     */
    private promoteNextAsActive(autoplay: boolean): string | null {
        if (!this.nextHowl || !this.nextSrc) return null;

        const promoted = this.nextHowl;
        const promotedSrc = this.nextSrc;
        const promotedFormat = this.nextFormat;
        const promotedTrackId = this.nextTrackId;

        // Detach preload refs first so the outgoing howl's guarded stop/unload
        // callbacks see `this.howl` already pointing at the promoted instance.
        this.nextHowl = null;
        this.nextSrc = null;
        this.nextFormat = undefined;
        this.nextTrackId = null;

        const old = this.howl;
        this.howl = promoted;
        this.state.currentSrc = promotedSrc;
        this.state.currentTime = 0;
        this.state.duration = promoted.duration() || 0;
        this.state.isPlaying = false;
        this.pendingPlay = false;
        this.isLoading = false;
        this.isChangingTrack = false;
        this.retryCount = 0;
        this.pendingAutoplay = autoplay;
        this.lastFormat = promotedFormat;
        this.shouldRetryLoads = this.isAndroidWebView();

        // Tear down the finished/previous track. Its guarded callbacks no-op now.
        if (old && old !== promoted) {
            try {
                old.stop();
                old.unload();
            } catch {
                // ignore
            }
        }

        console.log(`[HowlerEngine] Promoted preloaded track: ${promotedSrc.substring(0, 80)}...`);
        this.emit("load", { duration: this.state.duration });

        if (autoplay) {
            this.play();
        }

        return promotedTrackId;
    }

    /**
     * Preload the next queued track into a second Howl so it can be promoted
     * instantly (gapless, and without a background-throttled React load) when the
     * current track ends. No-op if it is already the current or preloaded src.
     */
    preloadNext(src: string, format?: string, trackId?: string | null): void {
        if (!src) return;
        if (src === this.state.currentSrc) return;
        if (src === this.nextSrc && this.nextHowl) return;

        this.clearPreload();
        this.nextSrc = src;
        this.nextFormat = format;
        this.nextTrackId = trackId ?? null;
        console.log(`[HowlerEngine] Preloading next track: ${src.substring(0, 80)}...`);
        this.createHowl(src, format, false, "preload");
    }

    /**
     * Discard any preloaded next track.
     */
    clearPreload(): void {
        if (this.nextHowl) {
            try {
                this.nextHowl.stop();
                this.nextHowl.unload();
            } catch {
                // ignore
            }
        }
        this.nextHowl = null;
        this.nextSrc = null;
        this.nextFormat = undefined;
        this.nextTrackId = null;
    }

    /**
     * Play audio (user-initiated)
     */
    play(): void {
        if (!this.howl) {
            console.warn("[HowlerEngine] No audio loaded");
            return;
        }

        // Don't play if still loading - wait for onload
        if (this.isLoading) {
            console.log("[HowlerEngine] play() called but still loading, skipping");
            return;
        }

        // Don't play if already playing or if a play is already pending
        // This prevents double-play when multiple callers trigger play() simultaneously
        // (especially during loading when onplay hasn't fired yet)
        if (this.state.isPlaying || this.pendingPlay || this.howl.playing()) {
            console.log(`[HowlerEngine] play() called but already playing/pending, skipping (isPlaying=${this.state.isPlaying}, pendingPlay=${this.pendingPlay})`);
            return;
        }

        // Set pendingPlay BEFORE calling howl.play() to guard against rapid re-calls
        this.pendingPlay = true;
        
        const sounds = this.getInternalHowl()?._sounds;
        console.log(
            `[HowlerEngine] play() - starting playback (sounds: ${sounds?.length || 0})`
        );
        
        // Mark as user-initiated for autoplay recovery
        this.userInitiatedPlay = true;

        // Ensure volume is set correctly before playing
        const targetVolume = this.state.isMuted ? 0 : this.state.volume;
        this.howl.volume(targetVolume);
        
        // Always call play() without sound ID - let Howler manage it
        // Using specific sound IDs was causing issues with newly created Howl instances
        this.howl.play();
    }

    /**
     * Check if a play request is pending (audio loading, play called but not yet started)
     */
    isPendingPlay(): boolean {
        return this.pendingPlay;
    }

    /**
     * Pause audio
     */
    pause(): void {
        if (!this.howl || !this.state.isPlaying) return;
        this.howl.pause();
    }

    /**
     * Stop playback completely
     */
    stop(): void {
        if (!this.howl) return;
        this.howl.stop();
    }

    /**
     * Seek to a specific time
     * Includes seek locking to prevent stale timeupdate events from causing UI flicker
     */
    seek(time: number): void {
        if (!this.howl) return;

        // Set seek lock - this prevents timeupdate from emitting stale values
        this.isSeeking = true;
        this.seekTargetTime = time;

        // Clear any existing seek timeout
        if (this.seekTimeoutId) {
            clearTimeout(this.seekTimeoutId);
        }

        this.state.currentTime = time;
        this.howl.seek(time);
        this.emit("seek", { time });

        // Release seek lock after audio has time to sync
        // This timeout ensures timeupdate doesn't emit stale values during the seek operation
        this.seekTimeoutId = setTimeout(() => {
            this.isSeeking = false;
            this.seekTargetTime = null;
            this.seekTimeoutId = null;
        }, 300);
    }

    /**
     * Check if currently in a seek operation
     */
    isCurrentlySeeking(): boolean {
        return this.isSeeking;
    }

    /**
     * Get the target seek position (if seeking)
     */
    getSeekTarget(): number | null {
        return this.seekTargetTime;
    }

    /**
     * Force reload the audio from current source
     * Used after cache is ready to enable seeking
     */
    reload(): void {
        if (!this.state.currentSrc) return;

        const src = this.state.currentSrc;
        const format = this.getInternalHowl()?._format;

        this.cleanup();
        this.load(src, false, format?.[0]);
    }

    /**
     * Set volume (0-1)
     */
    setVolume(volume: number): void {
        this.state.volume = Math.max(0, Math.min(1, volume));

        if (this.howl && !this.state.isMuted) {
            this.howl.volume(this.state.volume);
        }

        this.emit("volume", { volume: this.state.volume });
    }

    /**
     * Mute/unmute
     */
    setMuted(muted: boolean): void {
        this.state.isMuted = muted;

        if (this.howl) {
            this.howl.volume(muted ? 0 : this.state.volume);
        }
    }

    /**
     * Get current playback state
     */
    getState(): Readonly<HowlerEngineState> {
        return { ...this.state };
    }

    /**
     * Get current time (from Howler's state)
     */
    getCurrentTime(): number {
        if (this.howl) {
            const seek = this.howl.seek();
            return typeof seek === "number" ? seek : 0;
        }
        return 0;
    }

    /**
     * Get the ACTUAL current time from the HTML5 audio element
     * This is more accurate than Howler's reported position after failed seeks
     */
    getActualCurrentTime(): number {
        if (!this.howl) return 0;

        try {
            // Access the underlying HTML5 audio element
            const sounds = this.getInternalHowl()?._sounds;
            if (sounds && sounds.length > 0 && sounds[0]._node) {
                return sounds[0]._node.currentTime || 0;
            }
        } catch (_e) {
            // Fallback to Howler's reported time
        }

        return this.getCurrentTime();
    }

    /**
     * Get duration
     */
    getDuration(): number {
        return this.howl?.duration() || 0;
    }

    /**
     * Check if currently playing
     */
    isPlaying(): boolean {
        return this.howl?.playing() || false;
    }

    /**
     * Check if currently loading audio
     */
    isCurrentlyLoading(): boolean {
        return this.isLoading;
    }

    /**
     * Check if audio is loaded and ready to play
     */
    isLoaded(): boolean {
        return this.howl !== null && !this.isLoading && this.state.duration > 0;
    }

    /**
     * Get current source URL
     */
    getCurrentSrc(): string | null {
        return this.state.currentSrc;
    }

    /**
     * Subscribe to events
     */
    on(event: HowlerEventType, callback: HowlerEventCallback): void {
        this.eventListeners.get(event)?.add(callback);
    }

    /**
     * Unsubscribe from events
     */
    off(event: HowlerEventType, callback: HowlerEventCallback): void {
        this.eventListeners.get(event)?.delete(callback);
    }

    /**
     * Emit event to all listeners
     */
    private getInternalHowl(): HowlInternal | null {
        return this.howl as HowlInternal | null;
    }

    private emit(event: HowlerEventType, data?: unknown): void {
        this.eventListeners.get(event)?.forEach((callback) => {
            try {
                callback(data);
            } catch (err) {
                console.error(
                    `[HowlerEngine] Event listener error (${event}):`,
                    err
                );
            }
        });
    }

    /**
     * Start time update interval
     */
    private startTimeUpdates(): void {
        this.stopTimeUpdates();

        this.timeUpdateInterval = setInterval(() => {
            if (this.howl && this.state.isPlaying) {
                const seek = this.howl.seek();
                if (typeof seek === "number") {
                    // During a seek operation, ignore timeupdate events that report stale positions
                    // This prevents the UI flicker where old position briefly shows during seek
                    if (this.isSeeking && this.seekTargetTime !== null) {
                        const isNearTarget = Math.abs(seek - this.seekTargetTime) < 2;
                        if (!isNearTarget) {
                            // Stale position - don't emit, use target instead
                            return;
                        }
                        // Position is near target, seek completed - clear seek state
                        this.isSeeking = false;
                        this.seekTargetTime = null;
                        if (this.seekTimeoutId) {
                            clearTimeout(this.seekTimeoutId);
                            this.seekTimeoutId = null;
                        }
                    }
                    
                    this.state.currentTime = seek;
                    this.emit("timeupdate", { time: seek });
                }
            }
        }, 250); // Update 4 times per second
    }

    /**
     * Stop time update interval
     */
    private stopTimeUpdates(): void {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
    }

    /**
     * Cleanup current Howl instance
     */
    private cleanup(): void {
        console.log(`[HowlerEngine] cleanup() called, currentSrc: ${this.state.currentSrc?.substring(0, 50)}...`);
        
        // Mark that we're changing tracks - this suppresses stale errors from the old Howl
        this.isChangingTrack = true;

        this.stopTimeUpdates();

        // Any preloaded next track belongs to the outgoing context; drop it.
        this.clearPreload();

        // Cancel any pending cleanup timeout to prevent race conditions
        if (this.cleanupTimeoutId) {
            clearTimeout(this.cleanupTimeoutId);
            this.cleanupTimeoutId = null;
        }

        if (this.howl) {
            const oldHowl = this.howl;
            const internalOldHowl = oldHowl as HowlInternal;
            
            // Debug: check how many sounds exist
            const sounds = internalOldHowl._sounds;
            console.log(`[HowlerEngine] cleanup: ${sounds?.length || 0} sound(s) in Howl instance`);

            // Detach immediately so new loads don't race with cleanup.
            this.howl = null;

            try {
                // Always stop synchronously to prevent echo/double playback
                // The micro-fade caused race conditions where both old and new audio played
                oldHowl.stop();
                oldHowl.unload();
            } catch {
                // Ignore errors during cleanup
            }
        }

        // Note: Removed Howler.unload() - it was unloading ALL audio globally
        // which caused issues. Individual howl.unload() calls are sufficient.

        this.state.currentSrc = null;
        this.state.isPlaying = false;
        this.pendingPlay = false; // Clear pending flag on cleanup
        this.state.currentTime = 0;
        this.state.duration = 0;
    }

    /**
     * Destroy the engine completely
     */
    destroy(): void {
        this.cleanup();
        this.isLoading = false;
        this.eventListeners.clear();
        // Ensure cleanup timeout is cleared
        if (this.cleanupTimeoutId) {
            clearTimeout(this.cleanupTimeoutId);
            this.cleanupTimeoutId = null;
        }
        // Clear seek state
        if (this.seekTimeoutId) {
            clearTimeout(this.seekTimeoutId);
            this.seekTimeoutId = null;
        }
        this.isSeeking = false;
        this.seekTargetTime = null;
    }
}

// Export singleton instance
export const howlerEngine = new HowlerEngine();

// Also export class for testing
export { HowlerEngine };
