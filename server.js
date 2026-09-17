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

// Create folders
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
            return cb(new Error("Only MP4 videos are supported."));
        }

        cb(null, true);
    }
});

// =====================================================
// API STATUS
// =====================================================

app.get("/", (req, res) => {
    res.json({
        message: "Video Optimizer API is running!"
    });
});

// =====================================================
// PROCESS VIDEO
// =====================================================

app.post("/process", upload.single("video"), (req, res) => {

    if (!req.file) {
        return res.status(400).json({
            error: "No video uploaded."
        });
    }

    const inputPath = req.file.path;

    const originalName = path.parse(req.file.originalname).name;

    const outputName =
        `${originalName}-optimized-${Date.now()}.mp4`;

    const outputPath =
        path.join(OUTPUT_DIR, outputName);

    console.log("=================================");
    console.log("NEW VIDEO");
    console.log("Original:", req.file.originalname);
    console.log("=================================");

    // -------------------------------------------------
    // FFmpeg
    // -------------------------------------------------

    ffmpeg(inputPath)

        .outputOptions([
            "-c:v libx264",

            // Good compatibility
            "-profile:v high",
            "-level:v 4.2",
            "-pix_fmt yuv420p",

            // High quality
            "-crf 18",

            // Fast enough for Render
            "-preset veryfast",

            // Audio
            "-c:a aac",
            "-b:a 192k",

            // Web-friendly MP4
            "-movflags +faststart"
        ])

        .on("start", command => {
            console.log("FFmpeg started:");
            console.log(command);
        })

        .on("progress", progress => {

            if (progress.percent) {
                console.log(
                    `Processing: ${progress.percent.toFixed(1)}%`
                );
            }
        })

        .on("end", () => {

            console.log("VIDEO PROCESSING COMPLETE");

            // Remove temporary upload
            try {
                fs.unlinkSync(inputPath);
            } catch (err) {
                console.log(
                    "Could not delete upload:",
                    err.message
                );
            }

            return res.json({
                success: true,
                message: "Video processed successfully.",

                filename: outputName,

                // Keep this simple for the extension
                downloadUrl:
                    `/download/${encodeURIComponent(outputName)}`
            });
        })

        .on("error", error => {

            console.error("FFmpeg error:");
            console.error(error.message);

            // Delete input
            try {
                if (fs.existsSync(inputPath)) {
                    fs.unlinkSync(inputPath);
                }
            } catch {}

            // Delete broken output
            try {
                if (fs.existsSync(outputPath)) {
                    fs.unlinkSync(outputPath);
                }
            } catch {}

            if (!res.headersSent) {
                return res.status(500).json({
                    error: "Video processing failed.",
                    details: error.message
                });
            }
        })

        .save(outputPath);
});

// =====================================================
// DOWNLOAD
// =====================================================

app.get("/download/:filename", (req, res) => {

    const filename = path.basename(
        req.params.filename
    );

    const filePath =
        path.join(OUTPUT_DIR, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({
            error: "Processed video not found."
        });
    }

    res.download(filePath, filename);
});

// =====================================================
// ERROR HANDLER
// =====================================================

app.use((err, req, res, next) => {

    console.error("Server error:", err.message);

    if (err instanceof multer.MulterError) {

        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
                error: "Maximum file size is 500 MB."
            });
        }

        return res.status(400).json({
            error: err.message
        });
    }

    return res.status(400).json({
        error: err.message || "Something went wrong."
    });
});

// =====================================================
// START SERVER
// =====================================================

app.listen(PORT, "0.0.0.0", () => {

    console.log("---------------------------------");
    console.log("DONIAWIK VIDEO OPTIMIZER");
    console.log(`Running on port ${PORT}`);
    console.log("---------------------------------");
});
