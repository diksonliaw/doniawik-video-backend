const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// ===============================
// SETTINGS
// ===============================

app.use(cors());
app.use(express.json());

const UPLOADS = path.join(__dirname, "uploads");
const PROCESSED = path.join(__dirname, "processed");

// Create folders if they don't exist
if (!fs.existsSync(UPLOADS)) {
    fs.mkdirSync(UPLOADS, { recursive: true });
}

if (!fs.existsSync(PROCESSED)) {
    fs.mkdirSync(PROCESSED, { recursive: true });
}

// ===============================
// MULTER UPLOAD
// ===============================

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, UPLOADS);
    },

    filename: function (req, file, cb) {
        const uniqueName =
            Date.now() +
            "-" +
            Math.round(Math.random() * 1E9) +
            path.extname(file.originalname);

        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,

    limits: {
        fileSize: 500 * 1024 * 1024 // 500 MB
    },

    fileFilter: function (req, file, cb) {
        const extension = path.extname(file.originalname).toLowerCase();

        if (extension !== ".mp4") {
            return cb(new Error("Only MP4 videos are supported."));
        }

        cb(null, true);
    }
});

// ===============================
// HOME / API STATUS
// ===============================

app.get("/", (req, res) => {
    res.json({
        message: "Video Optimizer API is running!"
    });
});

// ===============================
// VIDEO PROCESSING
// ===============================

app.post("/process", upload.single("video"), (req, res) => {

    if (!req.file) {
        return res.status(400).json({
            error: "No video uploaded."
        });
    }

    const inputPath = req.file.path;

    const outputName =
        path.parse(req.file.filename).name +
        "-optimized.mp4";

    const outputPath = path.join(PROCESSED, outputName);

    console.log("Processing:", req.file.originalname);

    // Get video duration first
    ffmpeg.ffprobe(inputPath, (err, metadata) => {

        if (err) {
            console.error("FFprobe error:", err);

            try {
                fs.unlinkSync(inputPath);
            } catch {}

            return res.status(500).json({
                error: "Could not read video information."
            });
        }

        const totalDuration =
            metadata &&
            metadata.format &&
            metadata.format.duration
                ? metadata.format.duration
                : 0;

        ffmpeg(inputPath)
            .outputOptions([
                "-c:v libx264",
                "-profile:v high",
                "-level:v 4.2",

                // Fast encoding
                "-preset superfast",

                // Good quality
                "-crf 18",

                // Compatibility
                "-pix_fmt yuv420p",

                // AAC audio
                "-c:a aac",
                "-b:a 192k",

                // MP4 streaming optimization
                "-movflags +faststart"
            ])

            .on("start", commandLine => {
                console.log("FFmpeg started:");
                console.log(commandLine);
            })

            .on("progress", progress => {
                if (progress.percent) {
                    console.log(
                        `Progress: ${progress.percent.toFixed(1)}%`
                    );
                }
            })

            .on("end", () => {

                console.log("Processing complete!");

                // Delete uploaded original
                try {
                    fs.unlinkSync(inputPath);
                } catch (deleteError) {
                    console.log(
                        "Could not delete original:",
                        deleteError.message
                    );
                }

                res.json({
                    success: true,
                    message: "Video processed successfully.",
                    filename: outputName,
                    downloadUrl: `/download/${outputName}`
                });
            })

            .on("error", error => {

                console.error("FFmpeg error:", error);

                // Delete input
                try {
                    fs.unlinkSync(inputPath);
                } catch {}

                // Delete incomplete output
                try {
                    if (fs.existsSync(outputPath)) {
                        fs.unlinkSync(outputPath);
                    }
                } catch {}

                if (!res.headersSent) {
                    res.status(500).json({
                        error: "Video processing failed.",
                        details: error.message
                    });
                }
            })

            .save(outputPath);
    });
});

// ===============================
// DOWNLOAD PROCESSED VIDEO
// ===============================

app.get("/download/:filename", (req, res) => {

    const filename = path.basename(req.params.filename);
    const filePath = path.join(PROCESSED, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({
            error: "File not found."
        });
    }

    res.download(filePath, filename);
});

// ===============================
// ERROR HANDLER
// ===============================

app.use((err, req, res, next) => {

    console.error("Server error:", err);

    if (err instanceof multer.MulterError) {

        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({
                error: "File is too large. Maximum size is 500 MB."
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

// ===============================
// START SERVER
// ===============================

app.listen(PORT, () => {
    console.log(`Doniawik Video Optimizer running on port ${PORT}`);
});
