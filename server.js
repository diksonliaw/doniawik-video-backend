const express = require("express");
const cors = require("cors");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for Chrome Extensions and TikTok
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"]
}));

app.use(express.json());

// Set up storage directory
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer storage engine
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || ".mp4";
        cb(null, `${uuidv4()}_raw${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 } // 500 MB Limit
});

// In-Memory Job Storage
const jobs = new Map();

/*
|--------------------------------------------------------------------------
| Routes
|--------------------------------------------------------------------------
*/

// Healthcheck Endpoint
app.get("/api/status/healthcheck", (req, res) => {
    res.status(200).json({ status: "online", service: "Doniawik Video Backend" });
});

// Start Optimization Job Endpoint
app.post("/api/optimize", upload.single("video"), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No video file provided." });
    }

    const jobId = uuidv4();
    const inputPath = req.file.path;
    const outputPath = path.join(UPLOAD_DIR, `${jobId}_optimized.mp4`);

    // Initialize Job Status
    jobs.set(jobId, {
        status: "processing",
        progress: 0,
        inputPath,
        outputPath,
        error: null,
        createdAt: Date.now()
    });

    // Send immediate job creation response
    res.status(200).json({ jobId });

    // Probe duration first to accurately compute percentage
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
        const totalDuration = metadata && metadata.format ? metadata.format.duration : 0;

        ffmpeg(inputPath)
            .outputOptions([
                "-c:v libx264",
                "-crf 23",
                "-preset faster",
                "-c:a aac",
                "-b:a 128k",
                "-movflags +faststart" // Optimizes MP4 for fast web streaming / TikTok loading
            ])
            .output(outputPath)
            .on("progress", (progress) => {
                const job = jobs.get(jobId);
                if (!job) return;

                let percent = 0;
                if (progress.percent && !isNaN(progress.percent)) {
                    percent = Math.min(100, Math.max(0, progress.percent));
                } else if (totalDuration > 0 && progress.timemark) {
                    // Fallback manual percent calculation from timemark
                    const parts = progress.timemark.split(":");
                    const seconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
                    percent = Math.min(100, Math.max(0, (seconds / totalDuration) * 100));
                }

                job.progress = Math.round(percent);
            })
            .on("end", () => {
                const job = jobs.get(jobId);
                if (job) {
                    job.status = "completed";
                    job.progress = 100;
                }
                // Clean up raw original upload immediately
                fs.unlink(inputPath, () => {});
            })
            .on("error", (err) => {
                console.error(`FFmpeg processing error [${jobId}]:`, err.message);
                const job = jobs.get(jobId);
                if (job) {
                    job.status = "error";
                    job.error = "Failed to process video format.";
                }
                // Clean up raw upload on failure
                fs.unlink(inputPath, () => {});
            })
            .run();
    });
});

// Job Status Polling Endpoint
app.get("/api/status/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: "Job not found." });
    }

    res.status(200).json({
        status: job.status,
        progress: job.progress,
        error: job.error
    });
});

// Download Processed Video Endpoint
app.get("/api/download/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== "completed") {
        return res.status(400).json({ error: "Video is not ready for download." });
    }

    if (!fs.existsSync(job.outputPath)) {
        return res.status(404).json({ error: "Optimized file expired or deleted." });
    }

    res.download(job.outputPath, "optimized-video.mp4", (err) => {
        if (!err) {
            // Optional: Clean up output file after successful download
            fs.unlink(job.outputPath, () => {});
            jobs.delete(req.params.jobId);
        }
    });
});

/*
|--------------------------------------------------------------------------
| Automated Garbage Collector
|--------------------------------------------------------------------------
*/
// Clean up stalled/old files every 30 minutes (removes files older than 1 hour)
setInterval(() => {
    const now = Date.now();
    for (const [jobId, job] of jobs.entries()) {
        if (now - job.createdAt > 60 * 60 * 1000) {
            if (fs.existsSync(job.inputPath)) fs.unlink(job.inputPath, () => {});
            if (fs.existsSync(job.outputPath)) fs.unlink(job.outputPath, () => {});
            jobs.delete(jobId);
        }
    }
}, 30 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Doniawik Video Engine running on port ${PORT}`);
});
