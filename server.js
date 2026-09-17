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
    } catch (err) {
        console.log("Cleanup error:", err.message);
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
    return Math.round(number * factor) / factor;
}

function parseFPS(stream) {
    if (!stream) return 0;

    if (stream.avg_frame_rate) {
        const parts = String(stream.avg_frame_rate).split("/");

        if (parts.length === 2) {
            const numerator = Number(parts[0]);
            const denominator = Number(parts[1]);

            if (
                Number.isFinite(numerator) &&
                Number.isFinite(denominator) &&
                denominator !== 0
            ) {
                return numerator / denominator;
            }
        }
    }

    return safeNumber(stream.r_frame_rate, 0);
}

function chooseTargetFPS(sourceFPS) {
    if (!sourceFPS || sourceFPS <= 0) {
        return 30;
    }

    // Preserve common high-frame-rate footage.
    if (sourceFPS >= 59) {
        return 60;
    }

    if (sourceFPS >= 50) {
        return 50;
    }

    if (sourceFPS >= 29) {
        return 30;
    }

    if (sourceFPS >= 23) {
        return 24;
    }

    return Math.max(15, Math.round(sourceFPS));
}

function isVertical(width, height) {
    return height > width;
}

function isHorizontal(width, height) {
    return width > height;
}

// =====================================================
// DEEP VIDEO ANALYSIS
// =====================================================

function analyzeVideo(inputPath) {
    return new Promise((resolve, reject) => {

        ffmpeg.ffprobe(inputPath, (error, metadata) => {

            if (error) {
                return reject(error);
            }

            const streams = metadata.streams || [];

            const videoStream =
                streams.find(stream => stream.codec_type === "video");

            const audioStream =
                streams.find(stream => stream.codec_type === "audio");

            if (!videoStream) {
                return reject(
                    new Error("No video stream was found.")
                );
            }

            const width = safeNumber(videoStream.width);
            const height = safeNumber(videoStream.height);

            const fps = parseFPS(videoStream);

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

            const formatName =
                metadata.format?.format_name || "unknown";

            const codec =
                videoStream.codec_name || "unknown";

            const profile =
                videoStream.profile || "unknown";

            const pixelFormat =
                videoStream.pix_fmt || "unknown";

            const audioCodec =
                audioStream?.codec_name || null;

            const audioBitrate =
                safeNumber(audioStream?.bit_rate);

            const rotation =
                safeNumber(
                    videoStream.tags?.rotate ||
                    videoStream.side_data_list?.find(
                        item => item.rotation !== undefined
                    )?.rotation
                );

            const targetFPS = chooseTargetFPS(fps);

            const vertical = isVertical(width, height);
            const horizontal = isHorizontal(width, height);

            const megapixels =
                width && height
                    ? (width * height) / 1000000
                    : 0;

            const analysis = {
                width,
                height,
                fps: round(fps, 3),
                targetFPS,
                duration: round(duration, 3),
                bitrate,
                bitrateMbps:
                    bitrate
                        ? round(bitrate / 1000000, 2)
                        : 0,
                codec,
                profile,
                pixelFormat,
                formatName,
                audioCodec,
                audioBitrate,
                audioBitrateKbps:
                    audioBitrate
                        ? round(audioBitrate / 1000, 1)
                        : 0,
                rotation,
                vertical,
                horizontal,
                megapixels: round(megapixels, 2)
            };

            resolve(analysis);
        });
    });
}

// =====================================================
// SMART ENCODING PROFILE
// =====================================================

function buildEncodingProfile(info) {

    /*
     * Doniawik's goal:
     *
     * Preserve the original resolution.
     * Preserve high FPS where appropriate.
     * Avoid unnecessary upscaling.
     * Use high-quality H.264.
     * Keep broad compatibility.
     */

    let crf = 17;

    // Higher-detail / higher-resolution footage
    if (info.megapixels >= 3.5) {
        crf = 16;
    }

    // Lower-resolution footage
    if (info.megapixels <= 1.0) {
        crf = 18;
    }

    // Already heavily compressed sources
    // don't need an unnecessarily huge encode.
    if (
        info.bitrateMbps > 0 &&
        info.bitrateMbps < 4 &&
        info.megapixels <= 2.5
    ) {
        crf = 18;
    }

    let preset = "medium";

    /*
     * Render CPU time matters.
     * Medium gives substantially better compression efficiency
     * than veryfast while remaining practical.
     */

    if (info.duration > 600) {
        preset = "veryfast";
    }

    const fps = info.targetFPS;

    /*
     * GOP around 2 seconds.
     * This gives predictable seek/keyframe behavior.
     */
    const gop = Math.max(
        24,
        Math.round(fps * 2)
    );

    /*
     * Don't upscale source footage.
     * Resolution is preserved automatically.
     */
    const videoOptions = [
        "-c:v libx264",
        "-preset " + preset,
        "-crf " + crf,

        "-profile:v high",
        "-level:v 4.2",

        "-pix_fmt yuv420p",

        "-r " + fps,

        "-g " + gop,
        "-keyint_min " + gop,

        "-sc_threshold 0",

        "-bf 2",

        "-refs 3",

        "-movflags +faststart",

        "-c:a aac",
        "-b:a 192k",
        "-ar 48000",

        "-ac 2"
    ];

    return {
        crf,
        preset,
        gop,
        fps,
        videoOptions
    };
}

// =====================================================
// API STATUS
// =====================================================

app.get("/", (req, res) => {

    res.json({
        message: "Video Optimizer API is running!",
        engine: "Doniawik Smart Quality Engine",
        version: "2.0"
    });
});

// =====================================================
// PROCESS VIDEO
// =====================================================

app.post("/process", upload.single("video"), async (req, res) => {

    if (!req.file) {
        return res.status(400).json({
            error: "No video uploaded."
        });
    }

    const inputPath = req.file.path;

    const originalName =
        path.parse(req.file.originalname).name;

    const outputName =
        `${originalName}-optimized-${Date.now()}.mp4`;

    const outputPath =
        path.join(OUTPUT_DIR, outputName);

    console.log("");
    console.log("=================================");
    console.log("       DONIAWIK SMART ENGINE");
    console.log("=================================");
    console.log("Original:", req.file.originalname);
    console.log("Size:", req.file.size, "bytes");
    console.log("=================================");

    try {

        // -------------------------------------------------
        // STEP 1 — ANALYZE
        // -------------------------------------------------

        console.log("Analyzing video...");

        const analysis =
            await analyzeVideo(inputPath);

        console.log("");
        console.log("VIDEO ANALYSIS");
        console.log("---------------------------------");
        console.log(
            `Resolution: ${analysis.width}x${analysis.height}`
        );
        console.log(
            `FPS: ${analysis.fps}`
        );
        console.log(
            `Codec: ${analysis.codec}`
        );
        console.log(
            `Bitrate: ${analysis.bitrateMbps} Mbps`
        );
        console.log(
            `Pixel format: ${analysis.pixelFormat}`
        );
        console.log(
            `Audio: ${analysis.audioCodec || "none"}`
        );
        console.log(
            `Duration: ${analysis.duration}s`
        );
        console.log("---------------------------------");

        // -------------------------------------------------
        // STEP 2 — BUILD SMART PROFILE
        // -------------------------------------------------

        const profile =
            buildEncodingProfile(analysis);

        console.log("");
        console.log("DONIAWIK ENCODING PROFILE");
        console.log("---------------------------------");
        console.log(
            `CRF: ${profile.crf}`
        );
        console.log(
            `Preset: ${profile.preset}`
        );
        console.log(
            `Target FPS: ${profile.fps}`
        );
        console.log(
            `GOP: ${profile.gop}`
        );
        console.log("---------------------------------");

        // -------------------------------------------------
        // STEP 3 — PROCESS
        // -------------------------------------------------

        console.log("");
        console.log("Starting optimization...");

        await new Promise((resolve, reject) => {

            ffmpeg(inputPath)

                .outputOptions(
                    profile.videoOptions
                )

                .on("start", command => {

                    console.log("");
                    console.log("FFmpeg command:");
                    console.log(command);
                    console.log("");
                })

                .on("progress", progress => {

                    if (progress.percent) {

                        console.log(
                            `Processing: ${progress.percent.toFixed(1)}%`
                        );
                    }
                })

                .on("end", () => {

                    console.log("");
                    console.log(
                        "VIDEO PROCESSING COMPLETE"
                    );

                    resolve();
                })

                .on("error", error => {

                    console.error("");
                    console.error("FFmpeg error:");
                    console.error(error.message);

                    reject(error);
                })

                .save(outputPath);
        });

        // -------------------------------------------------
        // STEP 4 — VERIFY OUTPUT
        // -------------------------------------------------

        console.log("");
        console.log("Validating optimized video...");

        const outputAnalysis =
            await analyzeVideo(outputPath);

        const outputSize =
            fs.statSync(outputPath).size;

        console.log("");
        console.log("OUTPUT VALIDATION");
        console.log("---------------------------------");
        console.log(
            `Resolution: ${outputAnalysis.width}x${outputAnalysis.height}`
        );
        console.log(
            `FPS: ${outputAnalysis.fps}`
        );
        console.log(
            `Codec: ${outputAnalysis.codec}`
        );
        console.log(
            `Pixel format: ${outputAnalysis.pixelFormat}`
        );
        console.log(
            `Output size: ${outputSize} bytes`
        );
        console.log("---------------------------------");

        // -------------------------------------------------
        // STEP 5 — CLEAN ORIGINAL
        // -------------------------------------------------

        cleanupFile(inputPath);

        // -------------------------------------------------
        // FINAL RESPONSE
        // -------------------------------------------------

        return res.json({

            success: true,

            message:
                "Video optimized successfully.",

            engine:
                "Doniawik Smart Quality Engine",

            filename:
                outputName,

            downloadUrl:
                `/download/${encodeURIComponent(outputName)}`,

            analysis: {
                original: analysis,
                optimized: outputAnalysis
            },

            optimization: {
                crf: profile.crf,
                preset: profile.preset,
                targetFPS: profile.fps,
                gop: profile.gop
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
            "DONIAWIK PROCESSING FAILED:"
        );
        console.error(error.message);

        cleanupFile(inputPath);
        cleanupFile(outputPath);

        if (!res.headersSent) {

            return res.status(500).json({

                success: false,

                error:
                    "Video processing failed.",

                details:
                    error.message
            });
        }
    }
});

// =====================================================
// DOWNLOAD
// =====================================================

app.get("/download/:filename", (req, res) => {

    const filename =
        path.basename(req.params.filename);

    const filePath =
        path.join(OUTPUT_DIR, filename);

    if (!fs.existsSync(filePath)) {

        return res.status(404).json({

            error:
                "Processed video not found."
        });
    }

    res.download(
        filePath,
        filename
    );
});

// =====================================================
// ERROR HANDLER
// =====================================================

app.use((err, req, res, next) => {

    console.error(
        "Server error:",
        err.message
    );

    if (err instanceof multer.MulterError) {

        if (
            err.code === "LIMIT_FILE_SIZE"
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
});

// =====================================================
// START SERVER
// =====================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log("---------------------------------");
        console.log(
            "DONIAWIK SMART QUALITY ENGINE"
        );
        console.log(
            `Running on port ${PORT}`
        );
        console.log(
            "Engine version: 2.0"
        );
        console.log("---------------------------------");
    }
);
