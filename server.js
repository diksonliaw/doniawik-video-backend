const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 10000;

// ============================================================
// DIRECTORIES
// ============================================================

const UPLOAD_DIR = path.join(__dirname, "uploads");
const OUTPUT_DIR = path.join(__dirname, "processed");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// ============================================================
// MULTER
// ============================================================

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },

    filename: (req, file, cb) => {
        const extension = path.extname(file.originalname).toLowerCase();

        const filename =
            `${Date.now()}-${Math.random()
                .toString(36)
                .substring(2, 10)}${extension}`;

        cb(null, filename);
    }
});

const upload = multer({
    storage,

    limits: {
        fileSize: 500 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {
        const extension = path.extname(file.originalname).toLowerCase();

        if (extension !== ".mp4") {
            return cb(new Error("Only MP4 files are supported."));
        }

        cb(null, true);
    }
});

// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Video Optimizer API is running!",
        status: "online"
    });
});

// ============================================================
// PROCESS VIDEO
// ============================================================

app.post("/process", upload.single("video"), (req, res) => {

    if (!req.file) {
        return res.status(400).json({
            success: false,
            error: "No video uploaded."
        });
    }

    const inputPath = req.file.path;

    const baseName = path.parse(req.file.filename).name;

    const outputFilename = `${baseName}-optimized.mp4`;

    const outputPath = path.join(
        OUTPUT_DIR,
        outputFilename
    );

    console.log("========================================");
    console.log("NEW VIDEO");
    console.log("Original:", req.file.originalname);
    console.log("Input:", inputPath);
    console.log("Output:", outputPath);
    console.log("========================================");

    ffmpeg(inputPath)
        .outputOptions([
            // Video codec
            "-c:v libx264",

            // High compatibility
            "-profile:v high",
            "-level:v 4.2",
            "-pix_fmt yuv420p",

            // Quality
            "-crf 18",

            // Encoding speed
            "-preset veryfast",

            // Audio
            "-c:a aac",
            "-b:a 192k",

            // Better MP4 streaming
            "-movflags +faststart"
        ])

        .on("start", command => {
            console.log("FFmpeg command:");
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

            console.log("========================================");
            console.log("VIDEO COMPLETE");
            console.log(outputFilename);
            console.log("========================================");

            // Delete temporary upload
            try {
                fs.unlinkSync(inputPath);
            } catch (error) {
                console.log(
                    "Could not delete upload:",
                    error.message
                );
            }

            return res.status(200).json({
                success: true,
                message: "Video processed successfully.",

                filename: outputFilename,

                downloadUrl:
                    `/download/${encodeURIComponent(outputFilename)}`
            });
        })

        .on("error", error => {

            console.error("========================================");
            console.error("FFMPEG ERROR");
            console.error(error.message);
            console.error("========================================");

            // Delete uploaded file
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
                    success: false,
                    error: "Video processing failed.",
                    details: error.message
                });
            }
        })

        .save(outputPath);
});

// ============================================================
// DOWNLOAD
// ============================================================

app.get("/download/:filename", (req, res) => {

    // Prevent path traversal
    const filename = path.basename(
        req.params.filename
    );

    const filePath = path.join(
        OUTPUT_DIR,
        filename
    );

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({
            success: false,
            error: "Processed video not found."
        });
    }

    res.download(
        filePath,
        filename,
        error => {

            if (error) {
                console.error(
                    "Download error:",
                    error.message
                );
            }
        }
    );
});

// ============================================================
// ERROR HANDLER
// ============================================================

app.use((error, req, res, next) => {

    console.error("Server error:", error);

    if (error instanceof multer.MulterError) {

        if (error.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
                success: false,
                error: "Maximum file size is 500 MB."
            });
        }

        return res.status(400).json({
            success: false,
            error: error.message
        });
    }

    return res.status(400).json({
        success: false,
        error: error.message || "Something went wrong."
    });
});

// ============================================================
// START
// ============================================================

app.listen(PORT, "0.0.0.0", () => {

    console.log("");
    console.log("========================================");
    console.log(" DONIAWIK VIDEO OPTIMIZER");
    console.log("========================================");
    console.log(` Server running on port ${PORT}`);
    console.log(" API: ONLINE");
    console.log("========================================");
    console.log("");
});
