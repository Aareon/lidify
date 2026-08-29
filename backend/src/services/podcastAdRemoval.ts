import axios from "axios";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { prisma } from "../utils/db";
import { openRouterService } from "./openrouter";

/**
 * PodcastAdRemovalService - AI-powered podcast ad detection and removal
 *
 * Pipeline:
 * 1. Transcribe audio with Whishper (faster-whisper) → word-level timestamps
 * 2. Detect ad segments using LLM (OpenRouter/Claude) → time ranges
 * 3. Splice out ads using FFmpeg → clean audio file
 *
 * Architecture:
 * - Whishper runs as a sidecar container (similar to audio-analyzer)
 * - Uses OpenRouter for LLM (already configured for AI recommendations)
 * - FFmpeg is available in the backend container
 */

// Configuration
const WHISHPER_URL = process.env.WHISHPER_URL || "http://whishper:8080";
const AD_REMOVAL_ENABLED = process.env.PODCAST_AD_REMOVAL === "true";
// Whisper model: tiny (fastest), base, small, medium, large-v3 (most accurate)
const WHISPER_MODEL = process.env.WHISPER_MODEL || "medium";

/**
 * Get the LLM model to use for ad detection
 * Uses user's configured OpenRouter model (same as AI recommendations)
 * Can be overridden with AD_REMOVAL_MODEL env var
 */
export async function getAdRemovalModel(): Promise<string> {
    // Allow explicit override via env var
    if (process.env.AD_REMOVAL_MODEL) {
        return process.env.AD_REMOVAL_MODEL;
    }

    // Use the same model configured for AI recommendations
    try {
        const settings = await prisma.systemSettings.findFirst();
        // Default to Gemini 3 Flash - fast, cheap, excellent reasoning for ad detection
        return settings?.openrouterModel || "google/gemini-3-flash-preview";
    } catch {
        return "google/gemini-3-flash-preview";
    }
}

// Silence duration to insert between segments (ms)
const SILENCE_BETWEEN_SEGMENTS_MS = 500;

interface TranscriptSegment {
    start: number;  // seconds
    end: number;    // seconds
    text: string;
}

interface AdSegment {
    start: number;
    end: number;
    confidence: number;
    reason: string;
}

interface TranscriptionResult {
    segments: TranscriptSegment[];
    text: string;
    language: string;
}

/**
 * Check if ad removal is enabled and Whishper is available
 */
export async function isAdRemovalAvailable(): Promise<boolean> {
    if (!AD_REMOVAL_ENABLED) {
        return false;
    }

    if (!(await openRouterService.getApiKey())) {
        console.log("[AD-REMOVAL] OpenRouter API key not configured");
        return false;
    }

    try {
        // Try LinTO healthcheck first (returns "1" or {"healthcheck": "OK"})
        const lintoHealth = await axios.get(`${WHISHPER_URL}/healthcheck`, {
            timeout: 5000,
        });
        if (lintoHealth.status === 200) {
            return true;
        }
    } catch {
        // LinTO healthcheck failed, try onerahmet /docs endpoint
        try {
            const response = await axios.get(`${WHISHPER_URL}/docs`, {
                timeout: 5000,
                maxRedirects: 5,
            });
            return response.status === 200;
        } catch {
            // Both failed
        }
    }

    console.log("[AD-REMOVAL] Whishper not available at", WHISHPER_URL);
    return false;
}

/**
 * Detect which Whisper API is running (LinTO vs onerahmet)
 */
async function detectWhisperApi(): Promise<"linto" | "onerahmet" | "unknown"> {
    try {
        // Try LinTO healthcheck first
        const lintoHealth = await axios.get(`${WHISHPER_URL}/healthcheck`, { timeout: 3000 });
        if (lintoHealth.data === "1" || lintoHealth.data === 1 ||
            lintoHealth.data?.healthcheck === "OK") {
            return "linto";
        }
    } catch {}

    try {
        // Try onerahmet /docs endpoint
        const onerahmetHealth = await axios.get(`${WHISHPER_URL}/docs`, { timeout: 3000, maxRedirects: 5 });
        if (onerahmetHealth.status === 200) {
            return "onerahmet";
        }
    } catch {}

    return "unknown";
}

/**
 * Transcribe audio file using Whishper
 * Supports both LinTO-STT-Whisper and onerahmet/whisper-asr-webservice APIs
 */
async function transcribeAudio(audioPath: string): Promise<TranscriptionResult> {
    console.log(`[AD-REMOVAL] Transcribing: ${path.basename(audioPath)}`);

    const apiType = await detectWhisperApi();
    console.log(`[AD-REMOVAL] Detected Whisper API: ${apiType}`);

    // Use Node.js FormData for multipart upload
    const FormData = (await import("form-data")).default;
    const formData = new FormData();
    const fileStream = (await import("fs")).createReadStream(audioPath);

    try {
        let response;

        if (apiType === "linto") {
            // LinTO-STT-Whisper API: POST /transcribe with "file" param
            formData.append("file", fileStream, {
                filename: path.basename(audioPath),
                contentType: "audio/mpeg",
            });

            response = await axios.post(`${WHISHPER_URL}/transcribe`, formData, {
                headers: {
                    ...formData.getHeaders(),
                    "Accept": "application/json",  // LinTO requires explicit Accept header
                },
                timeout: 1800000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
        } else {
            // onerahmet API: POST /asr with "audio_file" param
            formData.append("audio_file", fileStream, {
                filename: path.basename(audioPath),
                contentType: "audio/mpeg",
            });

            const url = new URL(`${WHISHPER_URL}/asr`);
            url.searchParams.set("task", "transcribe");
            url.searchParams.set("language", "en");
            url.searchParams.set("output", "json");
            url.searchParams.set("word_timestamps", "true");

            response = await axios.post(url.toString(), formData, {
                headers: { ...formData.getHeaders() },
                timeout: 1800000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
        }

        const data = response.data;
        let segments: TranscriptSegment[] = [];
        let text = "";

        if (typeof data === "string") {
            text = data;
            console.log(`[AD-REMOVAL] Got plain text response (no timestamps)`);
        } else if (apiType === "linto" && data.words && Array.isArray(data.words)) {
            // LinTO returns word-level timestamps - group into segments
            text = data.text || "";
            // Create segments from words (group by ~30 second chunks)
            let currentSegment: TranscriptSegment = { start: 0, end: 0, text: "" };
            const SEGMENT_DURATION = 30; // seconds

            for (const word of data.words) {
                if (currentSegment.text === "") {
                    currentSegment.start = word.start;
                }
                currentSegment.text += (currentSegment.text ? " " : "") + word.word;
                currentSegment.end = word.end;

                // Start new segment every ~30 seconds
                if (word.end - currentSegment.start >= SEGMENT_DURATION) {
                    segments.push({ ...currentSegment });
                    currentSegment = { start: word.end, end: word.end, text: "" };
                }
            }
            // Add final segment
            if (currentSegment.text) {
                segments.push(currentSegment);
            }
            console.log(`[AD-REMOVAL] LinTO: ${data.words.length} words → ${segments.length} segments`);
        } else if (data.segments && Array.isArray(data.segments)) {
            segments = data.segments.map((seg: any) => ({
                start: seg.start,
                end: seg.end,
                text: seg.text,
            }));
            text = data.text || segments.map(s => s.text).join(" ");
        }

        console.log(`[AD-REMOVAL] Transcription complete: ${segments.length} segments, ${text.length} chars`);

        return {
            segments,
            text,
            language: data.language || "en",
        };
    } catch (error: any) {
        console.error("[AD-REMOVAL] Transcription failed:", error.message);
        if (error.response) {
            console.error("[AD-REMOVAL] Response:", error.response.status, error.response.data);
        }
        throw new Error(`Transcription failed: ${error.message}`);
    }
}

/**
 * Detect ad segments using LLM analysis
 * Sends transcript to Claude/GPT via OpenRouter
 */
async function detectAdSegments(transcript: TranscriptionResult): Promise<AdSegment[]> {
    const model = await getAdRemovalModel();
    console.log(`[AD-REMOVAL] Detecting ad segments with ${model}...`);

    // Format segments for LLM analysis
    const formattedTranscript = transcript.segments
        .map((seg, i) => `[${formatTime(seg.start)} - ${formatTime(seg.end)}] ${seg.text}`)
        .join("\n");

    const prompt = `You are an expert audio editor specializing in identifying and removing advertisements from podcasts.

## Task
Analyze this timestamped podcast transcript and identify ALL advertisement segments that should be removed.

## What IS an advertisement (REMOVE these):

### Traditional Ads:
- **Sponsor reads**: "This episode is brought to you by...", "Thanks to [Brand] for sponsoring..."
- **Promo codes**: "Use code PODCAST20 for 20% off", "Visit example.com/podcast"
- **Product pitches**: Extended descriptions of sponsor products/services with calls to action
- **Mid-roll ad breaks**: Sudden topic shifts to unrelated products (mattresses, VPNs, meal kits, etc.)
- **Pre-roll/post-roll ads**: Sponsor messages at the very beginning or end
- **Host-read ads**: When hosts personally endorse products with specific offers

### Foreign Language Ads (IMPORTANT):
- **Different language segments**: If the main podcast is in one language (e.g., English), remove segments that are clearly in a DIFFERENT language (e.g., Norwegian, German, Spanish ads inserted by regional ad networks)
- **Garbled/unintelligible text**: Segments where the transcript appears garbled, nonsensical, or has unusual character combinations often indicate foreign language audio that was poorly transcribed - these are typically localized ads
- **Sudden accent/language shifts**: Short segments with completely different speaking patterns from the main content
- **Regional brand names**: Unfamiliar brand names combined with promotional language patterns (even if transcribed poorly)

## What is NOT an advertisement (KEEP these):
- Podcast introductions and outros (theme music, "Welcome to the show")
- Mentions of their own podcast, Patreon, or social media
- Interview content, even if discussing a guest's products/books
- News or commentary about companies (unless it's clearly a paid promotion)
- General recommendations without affiliate codes or sponsored language
- Brief foreign words/phrases that are part of the natural conversation

## Detection Tips:
1. First, identify the PRIMARY language of the podcast from the majority of the transcript
2. Flag any segments that appear to be in a different language or are garbled
3. Look for ad patterns even in poorly-transcribed segments (short duration, positioned at start/mid/end)
4. When in doubt about garbled segments at typical ad positions (0:00-1:00, middle, last 2 min), mark them as ads

## Output Format
Return a JSON array. For each ad segment include:
- \`start\`: Start time in seconds (include 2-3 second lead-in buffer)
- \`end\`: End time in seconds (include 2-3 second buffer after)
- \`confidence\`: 0.0-1.0 (only include segments with confidence ≥ 0.8)
- \`reason\`: Brief explanation (e.g., "BetterHelp sponsor read with promo code" or "Foreign language ad segment")

If no ads found, return: []

## Example Output
[{"start": 118.0, "end": 185.5, "confidence": 0.95, "reason": "Athletic Greens sponsor read with discount code"},{"start": 32.0, "end": 45.0, "confidence": 0.85, "reason": "Foreign language ad - garbled transcript indicating non-English audio"}]

Respond with ONLY the JSON array, no markdown or explanation.

## Transcript
${formattedTranscript}`;

    try {
        const apiKey = await openRouterService.getApiKey();
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model,
                messages: [{ role: "user", content: prompt }],
                temperature: 0.1, // Low temperature for consistent detection
                max_tokens: 4000,
            },
            {
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://lidify.app",
                    "X-Title": "Lidify Podcast Ad Removal",
                },
                timeout: 60000,
            }
        );

        const content = response.data.choices[0]?.message?.content || "[]";
        console.log(`[AD-REMOVAL] Raw LLM response (first 500 chars): ${content.substring(0, 500)}`);

        // Parse JSON response (handle potential markdown wrapping and common issues)
        let jsonStr = content.trim();

        // Remove markdown code blocks
        if (jsonStr.startsWith("```")) {
            jsonStr = jsonStr.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
        }

        // Try to extract JSON array if there's extra text
        const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            jsonStr = arrayMatch[0];
        }

        // Fix common JSON issues from LLMs
        jsonStr = jsonStr
            .replace(/,\s*}/g, "}") // Remove trailing commas in objects
            .replace(/,\s*\]/g, "]") // Remove trailing commas in arrays
            .replace(/'/g, '"') // Replace single quotes with double quotes
            .replace(/(\w+):/g, '"$1":') // Quote unquoted keys (careful - may double-quote)
            .replace(/""+/g, '"'); // Fix double-double quotes

        let ads: AdSegment[] = [];
        try {
            ads = JSON.parse(jsonStr);
        } catch (parseError: any) {
            console.error("[AD-REMOVAL] JSON parse failed, trying fallback...");
            console.error("[AD-REMOVAL] Attempted to parse:", jsonStr.substring(0, 300));

            // Last resort: try to extract individual ad objects manually
            // Find all JSON-like objects and extract fields in any order
            const objectMatches = jsonStr.matchAll(/\{[^{}]+\}/g);
            for (const objMatch of objectMatches) {
                const obj = objMatch[0];
                const startMatch = obj.match(/"start"\s*:\s*([\d.]+)/);
                const endMatch = obj.match(/"end"\s*:\s*([\d.]+)/);
                const confMatch = obj.match(/"confidence"\s*:\s*([\d.]+)/);
                const reasonMatch = obj.match(/"reason"\s*:\s*"([^"]+)"/);

                if (startMatch && endMatch && confMatch) {
                    ads.push({
                        start: parseFloat(startMatch[1]),
                        end: parseFloat(endMatch[1]),
                        confidence: parseFloat(confMatch[1]),
                        reason: reasonMatch ? reasonMatch[1] : "Ad segment",
                    });
                }
            }

            if (ads.length === 0) {
                throw new Error(`JSON parse failed: ${parseError.message}`);
            }
            console.log(`[AD-REMOVAL] Fallback extraction found ${ads.length} ads`);
        }

        // Filter low-confidence detections (prompt asks for ≥0.8, but double-check)
        const filteredAds = ads.filter(ad => ad.confidence >= 0.75);

        console.log(`[AD-REMOVAL] Detected ${filteredAds.length} ad segments`);
        filteredAds.forEach(ad => {
            console.log(`  - ${formatTime(ad.start)}-${formatTime(ad.end)}: ${ad.reason} (${Math.round(ad.confidence * 100)}%)`);
        });

        return filteredAds;
    } catch (error: any) {
        console.error("[AD-REMOVAL] LLM detection failed:", error.message);
        throw new Error(`Ad detection failed: ${error.message}`);
    }
}

/**
 * Get audio bitrate using FFprobe
 */
async function getAudioBitrate(audioPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn("ffprobe", [
            "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=bit_rate",
            "-of", "default=noprint_wrappers=1:nokey=1",
            audioPath,
        ]);

        let output = "";
        ffprobe.stdout.on("data", (data) => {
            output += data.toString();
        });

        ffprobe.on("close", (code) => {
            if (code === 0) {
                const bitrate = parseInt(output.trim(), 10);
                // Default to 128k if we can't detect, return in kbps
                resolve(isNaN(bitrate) ? 128 : Math.round(bitrate / 1000));
            } else {
                resolve(128); // Default fallback
            }
        });

        ffprobe.on("error", () => resolve(128));
    });
}

/**
 * Remove ad segments from audio using FFmpeg
 * Creates a new file with ads spliced out
 */
async function spliceAudio(
    inputPath: string,
    outputPath: string,
    adSegments: AdSegment[]
): Promise<void> {
    if (adSegments.length === 0) {
        // No ads to remove, just copy the file
        await fs.copyFile(inputPath, outputPath);
        return;
    }

    console.log(`[AD-REMOVAL] Splicing out ${adSegments.length} ad segments...`);

    // Sort ads by start time
    const sortedAds = [...adSegments].sort((a, b) => a.start - b.start);

    // Calculate content segments (inverse of ad segments)
    const contentSegments: { start: number; end: number }[] = [];
    let currentPos = 0;

    for (const ad of sortedAds) {
        if (ad.start > currentPos) {
            contentSegments.push({ start: currentPos, end: ad.start });
        }
        currentPos = Math.max(currentPos, ad.end);
    }

    // Get audio duration and add final segment
    const duration = await getAudioDuration(inputPath);
    if (currentPos < duration) {
        contentSegments.push({ start: currentPos, end: duration });
    }

    if (contentSegments.length === 0) {
        throw new Error("No content segments remaining after ad removal");
    }

    // Get original bitrate to match quality
    const originalBitrate = await getAudioBitrate(inputPath);
    console.log(`[AD-REMOVAL] Original bitrate: ${originalBitrate}kbps`);

    // Create FFmpeg filter for concatenation
    // Uses the select filter to keep specific time ranges
    const filterParts: string[] = [];
    const inputLabels: string[] = [];

    contentSegments.forEach((seg, i) => {
        const label = `v${i}`;
        filterParts.push(
            `[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS[${label}]`
        );
        inputLabels.push(`[${label}]`);
    });

    // Add silence between segments for smooth transitions
    const silenceDuration = SILENCE_BETWEEN_SEGMENTS_MS / 1000;
    const concatFilter = `${inputLabels.join("")}concat=n=${contentSegments.length}:v=0:a=1[outa]`;

    const fullFilter = `${filterParts.join(";")};${concatFilter}`;

    // Run FFmpeg with matched bitrate
    await new Promise<void>((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
            "-y",           // Overwrite output
            "-i", inputPath,
            "-filter_complex", fullFilter,
            "-map", "[outa]",
            "-c:a", "libmp3lame",
            "-b:a", `${originalBitrate}k`,  // Match original bitrate
            outputPath,
        ]);

        let stderr = "";
        ffmpeg.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        ffmpeg.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                console.error("[AD-REMOVAL] FFmpeg error:", stderr);
                reject(new Error(`FFmpeg exited with code ${code}`));
            }
        });

        ffmpeg.on("error", reject);
    });

    // Log results
    const originalSize = (await fs.stat(inputPath)).size;
    const newSize = (await fs.stat(outputPath)).size;
    const totalAdTime = sortedAds.reduce((sum, ad) => sum + (ad.end - ad.start), 0);

    console.log(`[AD-REMOVAL] Complete: removed ${formatTime(totalAdTime)} of ads`);
    console.log(`[AD-REMOVAL] Size: ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(newSize / 1024 / 1024).toFixed(1)}MB`);
}

/**
 * Get audio duration using FFprobe
 */
async function getAudioDuration(audioPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const ffprobe = spawn("ffprobe", [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            audioPath,
        ]);

        let output = "";
        ffprobe.stdout.on("data", (data) => {
            output += data.toString();
        });

        ffprobe.on("close", (code) => {
            if (code === 0) {
                resolve(parseFloat(output.trim()) || 0);
            } else {
                reject(new Error("Failed to get audio duration"));
            }
        });

        ffprobe.on("error", reject);
    });
}

/**
 * Format seconds as MM:SS
 */
function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Main entry point: Process a podcast episode to remove ads
 *
 * @param inputPath - Path to original podcast audio file
 * @param outputPath - Path for cleaned audio output
 * @returns Object with processing results
 */
export async function removeAdsFromPodcast(
    inputPath: string,
    outputPath?: string
): Promise<{
    success: boolean;
    adsRemoved: number;
    totalAdTime: number;
    outputPath: string;
    error?: string;
}> {
    const finalOutputPath = outputPath || inputPath.replace(/\.mp3$/, ".clean.mp3");

    try {
        // Check if service is available
        if (!await isAdRemovalAvailable()) {
            return {
                success: false,
                adsRemoved: 0,
                totalAdTime: 0,
                outputPath: inputPath,
                error: "Ad removal service not available",
            };
        }

        console.log(`[AD-REMOVAL] Processing: ${path.basename(inputPath)}`);

        // Step 1: Transcribe
        const transcript = await transcribeAudio(inputPath);

        if (!transcript.segments.length) {
            console.log("[AD-REMOVAL] No transcript segments, skipping ad detection");
            return {
                success: true,
                adsRemoved: 0,
                totalAdTime: 0,
                outputPath: inputPath,
            };
        }

        // Step 2: Detect ads
        const adSegments = await detectAdSegments(transcript);

        if (adSegments.length === 0) {
            console.log("[AD-REMOVAL] No ads detected");
            return {
                success: true,
                adsRemoved: 0,
                totalAdTime: 0,
                outputPath: inputPath,
            };
        }

        // Step 3: Splice out ads
        await spliceAudio(inputPath, finalOutputPath, adSegments);

        const totalAdTime = adSegments.reduce((sum, ad) => sum + (ad.end - ad.start), 0);

        return {
            success: true,
            adsRemoved: adSegments.length,
            totalAdTime,
            outputPath: finalOutputPath,
        };

    } catch (error: any) {
        console.error("[AD-REMOVAL] Processing failed:", error.message);
        return {
            success: false,
            adsRemoved: 0,
            totalAdTime: 0,
            outputPath: inputPath,
            error: error.message,
        };
    }
}

/**
 * Process a cached podcast episode (integrates with podcastDownload.ts)
 * Replaces the cached file with the ad-free version
 */
export async function processDownloadedEpisode(
    episodeId: string,
    cachedPath: string,
    userId?: string
): Promise<boolean> {
    // Import notification service lazily to avoid circular deps
    const { notificationService } = await import("./notificationService");

    // Fetch episode and podcast info for notifications
    const episode = await prisma.podcastEpisode.findUnique({
        where: { id: episodeId },
        include: { podcast: { select: { title: true } } },
    });

    const podcastName = episode?.podcast?.title || "Podcast";
    const episodeTitle = episode?.title || "Episode";
    const subject = `${podcastName} - ${episodeTitle}`;

    // Create a DownloadJob entry to track this in the Active tab
    let jobId: string | null = null;
    if (userId) {
        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject,
                type: "ad_removal",
                status: "processing",
                startedAt: new Date(),
                metadata: { episodeId, podcastName, episodeTitle },
            },
        });
        jobId = job.id;
        console.log(`[AD-REMOVAL] Created job ${jobId} for tracking`);
    }

    try {
        const tempOutput = cachedPath.replace(/\.mp3$/, ".adremoved.mp3");

        const result = await removeAdsFromPodcast(cachedPath, tempOutput);

        if (result.success && result.adsRemoved > 0) {
            // Replace original with cleaned version
            await fs.rename(tempOutput, cachedPath);
            console.log(`[AD-REMOVAL] Episode ${episodeId}: replaced with ad-free version`);

            // Get new file size after ad removal
            const newStats = await fs.stat(cachedPath);
            const newFileSizeMb = newStats.size / 1024 / 1024;

            // Update PodcastDownload to mark ads as removed AND update file size
            await prisma.podcastDownload.updateMany({
                where: { episodeId },
                data: {
                    adsRemoved: true,
                    adsRemovedAt: new Date(),
                    adSecondsRemoved: result.totalAdTime,
                    fileSizeMb: newFileSizeMb,
                },
            });

            // Update PodcastEpisode.fileSize so cache validator doesn't invalidate
            await prisma.podcastEpisode.update({
                where: { id: episodeId },
                data: { fileSize: newStats.size },
            });

            console.log(`[AD-REMOVAL] Episode ${episodeId}: marked as ad-free in database (${newFileSizeMb.toFixed(1)}MB)`);

            // Mark job as completed and create notification
            if (userId && jobId) {
                await prisma.downloadJob.update({
                    where: { id: jobId },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                        metadata: {
                            episodeId,
                            podcastName,
                            episodeTitle,
                            adsRemoved: result.adsRemoved,
                            timeRemoved: formatTime(result.totalAdTime),
                            secondsRemoved: result.totalAdTime,
                        },
                    },
                });

                // Create completion notification with details
                await notificationService.notifyAdRemovalComplete(
                    userId,
                    podcastName,
                    episodeTitle,
                    result.adsRemoved,
                    formatTime(result.totalAdTime)
                );
            }

            return true;
        }

        // No ads found - mark job as completed with no changes
        if (userId && jobId) {
            await prisma.downloadJob.update({
                where: { id: jobId },
                data: {
                    status: "completed",
                    completedAt: new Date(),
                    metadata: { episodeId, podcastName, episodeTitle, adsRemoved: 0 },
                },
            });
        }

        // Clean up temp file if it exists
        await fs.unlink(tempOutput).catch(() => {});
        return false;

    } catch (error: any) {
        console.error(`[AD-REMOVAL] Failed to process episode ${episodeId}:`, error.message);

        // Mark job as failed
        if (userId && jobId) {
            await prisma.downloadJob.update({
                where: { id: jobId },
                data: {
                    status: "failed",
                    error: error.message,
                    completedAt: new Date(),
                },
            });
        }

        return false;
    }
}
