const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "processed");

// =====================================================
// DIRECTORIES
// =====================================================

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(cors());
app.use(express.json());

// =====================================================
// FILE UPLOAD
// =====================================================

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },

    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();

        const safeName =
            `${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 10)}${ext}`;

        cb(null, safeName);
    }
});

const upload = multer({
    storage: storage,

    limits: {
        fileSize: 500 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();

        if (ext !== ".mp4") {
            return cb(
                new Error("Only MP4 videos are supported.")
            );
        }

        cb(null, true);
    }
});

// =====================================================
// HELPERS
// =====================================================

function cleanupFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.log(
            "Cleanup error:",
            error.message
        );
    }
}

function safeNumber(value, fallback = 0) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return number;
}

function round(number, decimals = 2) {
    const factor = Math.pow(10, decimals);

    return Math.round(
        number * factor
    ) / factor;
}

// =====================================================
// FPS DETECTION
// =====================================================

function parseFPS(stream) {

    if (!stream) {
        return 0;
    }

    const frameRate =
        stream.avg_frame_rate ||
        stream.r_frame_rate;

    if (!frameRate) {
        return 0;
    }

    const parts =
        String(frameRate).split("/");

    if (parts.length === 2) {

        const numerator =
            Number(parts[0]);

        const denominator =
            Number(parts[1]);

        if (
            Number.isFinite(numerator) &&
            Number.isFinite(denominator) &&
            denominator !== 0
        ) {
            return numerator / denominator;
        }
    }

    return safeNumber(
        frameRate,
        0
    );
}

// =====================================================
// SMART FPS
// =====================================================

function chooseTargetFPS(sourceFPS) {

    if (
        !sourceFPS ||
        sourceFPS <= 0
    ) {
        return 30;
    }

    // Preserve 60 FPS gameplay
    if (sourceFPS >= 59) {
        return 60;
    }

    // Preserve common 50 FPS
    if (sourceFPS >= 49) {
        return 50;
    }

    // Preserve normal 30 FPS
    if (sourceFPS >= 29) {
        return 30;
    }

    // Preserve 24 FPS
    if (sourceFPS >= 23) {
        return 24;
    }

    return Math.max(
        15,
        Math.round(sourceFPS)
    );
}

// =====================================================
// VIDEO ANALYZER
// =====================================================

function analyzeVideo(inputPath) {

    return new Promise(
        (resolve, reject) => {

            ffmpeg.ffprobe(
                inputPath,
                (error, metadata) => {

                    if (error) {
                        return reject(error);
                    }

                    const streams =
                        metadata.streams || [];

                    const videoStream =
                        streams.find(
                            stream =>
                                stream.codec_type ===
                                "video"
                        );

                    const audioStream =
                        streams.find(
                            stream =>
                                stream.codec_type ===
                                "audio"
                        );

                    if (!videoStream) {

                        return reject(
                            new Error(
                                "No video stream was found."
                            )
                        );
                    }

                    const width =
                        safeNumber(
                            videoStream.width
                        );

                    const height =
                        safeNumber(
                            videoStream.height
                        );

                    const fps =
                        parseFPS(
                            videoStream
                        );

                    const duration =
                        safeNumber(
                            videoStream.duration ||
                            metadata.format?.duration
                        );

                    const bitrate =
                        safeNumber(
                            videoStream.bit_rate ||
                            metadata.format?.bit_rate
                        );

                    const codec =
                        videoStream.codec_name ||
                        "unknown";

                    const profile =
                        videoStream.profile ||
                        "unknown";

                    const pixelFormat =
                        videoStream.pix_fmt ||
                        "unknown";

                    const audioCodec =
                        audioStream?.codec_name ||
                        null;

                    const audioBitrate =
                        safeNumber(
                            audioStream?.bit_rate
                        );

                    const formatName =
                        metadata.format?.format_name ||
                        "unknown";

                    const targetFPS =
                        chooseTargetFPS(
                            fps
                        );

                    const megapixels =
                        width && height
                            ? (
                                width *
                                height
                            ) / 1000000
                            : 0;

                    const vertical =
                        height > width;

                    const horizontal =
                        width > height;

                    resolve({

                        width,
                        height,

                        fps:
                            round(
                                fps,
                                3
                            ),

                        targetFPS,

                        duration:
                            round(
                                duration,
                                3
                            ),

                        bitrate,

                        bitrateMbps:
                            bitrate
                                ? round(
                                    bitrate /
                                    1000000,
                                    2
                                )
                                : 0,

                        codec,

                        profile,

                        pixelFormat,

                        formatName,

                        audioCodec,

                        audioBitrate,

                        audioBitrateKbps:
                            audioBitrate
                                ? round(
                                    audioBitrate /
                                    1000,
                                    1
                                )
                                : 0,

                        megapixels:
                            round(
                                megapixels,
                                2
                            ),

                        vertical,

                        horizontal
                    });
                }
            );
        }
    );
}

// =====================================================
// SMART ENCODING ENGINE
// =====================================================

function buildEncodingProfile(info) {

    /*
     * DONIAWIK SMART QUALITY ENGINE
     *
     * Main goals:
     *
     * 1. Preserve original resolution
     * 2. Preserve high FPS
     * 3. Avoid unnecessary upscaling
     * 4. Use highly compatible H.264
     * 5. Produce TikTok-friendly MP4
     * 6. Maintain high visual quality
     */

    let crf = 17;

    // High-resolution footage
    if (
        info.megapixels >= 3
    ) {
        crf = 16;
    }

    // Lower-resolution footage
    if (
        info.megapixels <= 1
    ) {
        crf = 18;
    }

    // Very low bitrate source
    if (
        info.bitrateMbps > 0 &&
        info.bitrateMbps < 4
    ) {
        crf = 18;
    }

    /*
     * Encoding speed.
     *
     * medium = better compression efficiency
     * veryfast = useful for very long videos
     */

    let preset = "medium";

    if (
        info.duration > 600
    ) {
        preset = "veryfast";
    }

    /*
     * Two-second keyframe interval.
     *
     * 60 FPS → 120
     * 30 FPS → 60
     */

    const gop =
        Math.max(
            24,
            Math.round(
                info.targetFPS * 2
            )
        );

    const videoOptions = [

        // -------------------------------------------------
        // VIDEO CODEC
        // -------------------------------------------------

        "-c:v libx264",

        // High-quality encoding
        "-preset " + preset,

        "-crf " + crf,

        // -------------------------------------------------
        // COMPATIBILITY
        // -------------------------------------------------

        "-profile:v high",

        /*
         * Level 4.1 is deliberately conservative.
         * This avoids unnecessarily aggressive H.264
         * parameters that some upload pipelines dislike.
         */

        "-level:v 4.1",

        // Widely compatible pixel format
        "-pix_fmt yuv420p",

        // -------------------------------------------------
        // FRAME RATE
        // -------------------------------------------------

        "-r " + info.targetFPS,

        // -------------------------------------------------
        // KEYFRAMES
        // -------------------------------------------------

        "-g " + gop,

        "-keyint_min " + gop,

        /*
         * Predictable GOP structure
         */
        "-sc_threshold 0",

        // -------------------------------------------------
        // B-FRAMES
        // -------------------------------------------------

        "-bf 2",

        // -------------------------------------------------
        // AUDIO
        // -------------------------------------------------

        "-c:a aac",

        "-b:a 192k",

        "-ar 48000",

        "-ac 2",

        // -------------------------------------------------
        // MP4
        // -------------------------------------------------

        "-movflags +faststart"
    ];

    return {

        crf,

        preset,

        gop,

        fps:
            info.targetFPS,

        videoOptions
    };
}

// =====================================================
// API STATUS
// =====================================================

app.get("/", (req, res) => {

    res.json({

        message:
            "Video Optimizer API is running!",

        engine:
            "Doniawik Smart Quality Engine",

        version:
            "2.1"
    });
});

// =====================================================
// PROCESS VIDEO
// =====================================================

app.post(
    "/process",
    upload.single("video"),
    async (req, res) => {

        if (!req.file) {

            return res.status(400).json({

                error:
                    "No video uploaded."
            });
        }

        const inputPath =
            req.file.path;

        const originalName =
            path.parse(
                req.file.originalname
            ).name;

        const outputName =
            `${originalName}-optimized-${Date.now()}.mp4`;

        const outputPath =
            path.join(
                OUTPUT_DIR,
                outputName
            );

        console.log("");
        console.log(
            "================================="
        );
        console.log(
            "     DONIAWIK SMART ENGINE"
        );
        console.log(
            "================================="
        );

        console.log(
            "Original:",
            req.file.originalname
        );

        console.log(
            "Upload size:",
            req.file.size,
            "bytes"
        );

        console.log(
            "================================="
        );

        try {

            // =================================================
            // STEP 1 — DEEP ANALYSIS
            // =================================================

            console.log(
                "Analyzing video..."
            );

            const analysis =
                await analyzeVideo(
                    inputPath
                );

            console.log("");
            console.log(
                "VIDEO ANALYSIS"
            );

            console.log(
                "---------------------------------"
            );

            console.log(
                "Resolution:",
                `${analysis.width}x${analysis.height}`
            );

            console.log(
                "FPS:",
                analysis.fps
            );

            console.log(
                "Target FPS:",
                analysis.targetFPS
            );

            console.log(
                "Codec:",
                analysis.codec
            );

            console.log(
                "Profile:",
                analysis.profile
            );

            console.log(
                "Pixel format:",
                analysis.pixelFormat
            );

            console.log(
                "Bitrate:",
                `${analysis.bitrateMbps} Mbps`
            );

            console.log(
                "Audio:",
                analysis.audioCodec ||
                "none"
            );

            console.log(
                "Duration:",
                `${analysis.duration}s`
            );

            console.log(
                "---------------------------------"
            );

            // =================================================
            // STEP 2 — SMART PROFILE
            // =================================================

            const profile =
                buildEncodingProfile(
                    analysis
                );

            console.log("");
            console.log(
                "DONIAWIK ENCODING PROFILE"
            );

            console.log(
                "---------------------------------"
            );

            console.log(
                "CRF:",
                profile.crf
            );

            console.log(
                "Preset:",
                profile.preset
            );

            console.log(
                "Target FPS:",
                profile.fps
            );

            console.log(
                "GOP:",
                profile.gop
            );

            console.log(
                "---------------------------------"
            );

            // =================================================
            // STEP 3 — HIGH QUALITY ENCODE
            // =================================================

            console.log("");
            console.log(
                "Starting optimization..."
            );

            await new Promise(
                (resolve, reject) => {

                    ffmpeg(inputPath)

                        .outputOptions(
                            profile.videoOptions
                        )

                        .on(
                            "start",
                            command => {

                                console.log("");
                                console.log(
                                    "FFmpeg command:"
                                );

                                console.log(
                                    command
                                );

                                console.log("");
                            }
                        )

                        .on(
                            "progress",
                            progress => {

                                if (
                                    progress.percent
                                ) {

                                    console.log(
                                        `Processing: ${progress.percent.toFixed(1)}%`
                                    );
                                }
                            }
                        )

                        .on(
                            "end",
                            () => {

                                console.log("");

                                console.log(
                                    "VIDEO PROCESSING COMPLETE"
                                );

                                resolve();
                            }
                        )

                        .on(
                            "error",
                            error => {

                                console.error("");

                                console.error(
                                    "FFmpeg error:"
                                );

                                console.error(
                                    error.message
                                );

                                reject(
                                    error
                                );
                            }
                        )

                        .save(
                            outputPath
                        );
                }
            );

            // =================================================
            // STEP 4 — VERIFY OUTPUT
            // =================================================

            console.log("");

            console.log(
                "Validating optimized video..."
            );

            const outputAnalysis =
                await analyzeVideo(
                    outputPath
                );

            const outputSize =
                fs.statSync(
                    outputPath
                ).size;

            console.log("");

            console.log(
                "OUTPUT VALIDATION"
            );

            console.log(
                "---------------------------------"
            );

            console.log(
                "Resolution:",
                `${outputAnalysis.width}x${outputAnalysis.height}`
            );

            console.log(
                "FPS:",
                outputAnalysis.fps
            );

            console.log(
                "Codec:",
                outputAnalysis.codec
            );

            console.log(
                "Profile:",
                outputAnalysis.profile
            );

            console.log(
                "Pixel format:",
                outputAnalysis.pixelFormat
            );

            console.log(
                "Audio:",
                outputAnalysis.audioCodec
            );

            console.log(
                "Output size:",
                outputSize,
                "bytes"
            );

            console.log(
                "---------------------------------"
            );

            // =================================================
            // STEP 5 — BASIC VALIDATION
            // =================================================

            if (
                outputAnalysis.codec !==
                "h264"
            ) {

                throw new Error(
                    "Output validation failed: video is not H.264."
                );
            }

            if (
                outputAnalysis.pixelFormat !==
                "yuv420p"
            ) {

                throw new Error(
                    "Output validation failed: incompatible pixel format."
                );
            }

            if (
                !outputAnalysis.width ||
                !outputAnalysis.height
            ) {

                throw new Error(
                    "Output validation failed: invalid resolution."
                );
            }

            if (
                !outputAnalysis.duration
            ) {

                throw new Error(
                    "Output validation failed: invalid duration."
                );
            }

            // =================================================
            // STEP 6 — REMOVE TEMP UPLOAD
            // =================================================

            cleanupFile(
                inputPath
            );

            // =================================================
            // STEP 7 — FINAL RESPONSE
            // =================================================

            console.log("");

            console.log(
                "DONIAWIK OPTIMIZATION SUCCESS"
            );

            console.log(
                "================================="
            );

            return res.json({

                success: true,

                message:
                    "Video optimized successfully.",

                engine:
                    "Doniawik Smart Quality Engine",

                version:
                    "2.1",

                filename:
                    outputName,

                downloadUrl:
                    `/download/${encodeURIComponent(
                        outputName
                    )}`,

                analysis: {

                    original:
                        analysis,

                    optimized:
                        outputAnalysis
                },

                optimization: {

                    codec:
                        "H.264",

                    profile:
                        "High",

                    level:
                        "4.1",

                    pixelFormat:
                        "yuv420p",

                    crf:
                        profile.crf,

                    preset:
                        profile.preset,

                    targetFPS:
                        profile.fps,

                    gop:
                        profile.gop,

                    audio:
                        "AAC 192kbps",

                    sampleRate:
                        "48000 Hz"
                },

                file: {

                    originalSize:
                        req.file.size,

                    optimizedSize:
                        outputSize
                }
            });

        } catch (error) {

            console.error("");

            console.error(
                "DONIAWIK PROCESSING FAILED"
            );

            console.error(
                error.message
            );

            cleanupFile(
                inputPath
            );

            cleanupFile(
                outputPath
            );

            if (
                !res.headersSent
            ) {

                return res.status(500).json({

                    success: false,

                    error:
                        "Video processing failed.",

                    details:
                        error.message
                });
            }
        }
    }
);

// =====================================================
// DOWNLOAD
// =====================================================

app.get(
    "/download/:filename",
    (req, res) => {

        const filename =
            path.basename(
                req.params.filename
            );

        const filePath =
            path.join(
                OUTPUT_DIR,
                filename
            );

        if (
            !fs.existsSync(
                filePath
            )
        ) {

            return res.status(404).json({

                error:
                    "Processed video not found."
            });
        }

        res.download(
            filePath,
            filename
        );
    }
);

// =====================================================
// ERROR HANDLER
// =====================================================

app.use(
    (err, req, res, next) => {

        console.error(
            "Server error:",
            err.message
        );

        if (
            err instanceof
            multer.MulterError
        ) {

            if (
                err.code ===
                "LIMIT_FILE_SIZE"
            ) {

                return res.status(413).json({

                    error:
                        "Maximum file size is 500 MB."
                });
            }

            return res.status(400).json({

                error:
                    err.message
            });
        }

        return res.status(400).json({

            error:
                err.message ||
                "Something went wrong."
        });
    }
);

// =====================================================
// START SERVER
// =====================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "---------------------------------"
        );

        console.log(
            "DONIAWIK SMART QUALITY ENGINE"
        );

        console.log(
            `Running on port ${PORT}`
        );

        console.log(
            "Engine version: 2.1"
        );

        console.log(
            "---------------------------------"
        );
    }
);
