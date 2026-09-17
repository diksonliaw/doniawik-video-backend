const express = require("express");
const multer = require("multer");
const ffmpeg = require("fluent-ffmpeg");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 5000;

const uploadFolder = path.join(__dirname, "uploads");
const outputFolder = path.join(__dirname, "processed");

fs.mkdirSync(uploadFolder, { recursive: true });
fs.mkdirSync(outputFolder, { recursive: true });

app.use(cors());

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadFolder);
    },

    filename: (req, file, cb) => {
        cb(null, `${crypto.randomUUID()}.mp4`);
    }
});

const upload = multer({
    storage,

    limits: {
        fileSize: 500 * 1024 * 1024
    },

    fileFilter: (req, file, cb) => {
        const isMp4 =
            file.mimetype === "video/mp4" ||
            path.extname(file.originalname).toLowerCase() === ".mp4";

        if (!isMp4) {
            return cb(
                new Error("Only MP4 videos are supported.")
            );
        }

        cb(null, true);
    }
});

app.get("/", (req, res) => {
    res.json({
        message: "Video Optimizer API is running!"
    });
});

app.get("/api/health", (req, res) => {
    res.json({
        status: "online",
        service: "Doniawik Video Optimizer"
    });
});

app.post(
    "/api/optimize",
    upload.single("video"),
    async (req, res) => {

        if (!req.file) {
            return res.status(400).json({
                error: "No video uploaded."
            });
        }

        const inputPath = req.file.path;

        const outputName =
            `${path.parse(req.file.filename).name}-optimized.mp4`;

        const outputPath =
            path.join(outputFolder, outputName);

        console.log("=================================");
        console.log("Doniawik optimization started");
        console.log("Original:", req.file.originalname);
        console.log(
            "Size:",
            (req.file.size / 1024 / 1024).toFixed(2),
            "MB"
        );
        console.log("=================================");

        try {

            await new Promise((resolve, reject) => {

                ffmpeg.ffprobe(
                    inputPath,
                    (probeError, metadata) => {

                        if (probeError) {
                            return reject(probeError);
                        }

                        const duration =
                            metadata?.format?.duration || 0;

                        console.log(
                            "Duration:",
                            duration,
                            "seconds"
                        );

                        ffmpeg(inputPath)

                            .outputOptions([
                                "-c:v libx264",
                                "-profile:v high",
                                "-level:v 4.2",

                                "-preset superfast",

                                "-crf 18",

                                "-maxrate 15M",
                                "-bufsize 30M",

                                "-pix_fmt yuv420p",

                                "-vf",
                                "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,unsharp=3:3:0.4:3:3:0.0",

                                "-r 60",

                                "-c:a aac",
                                "-b:a 192k",
                                "-ar 48000",

                                "-movflags +faststart"
                            ])

                            .output(outputPath)

                            .on("start", command => {
                                console.log(
                                    "FFmpeg command:",
                                    command
                                );
                            })

                            .on("progress", progress => {

                                let percent = 0;

                                if (
                                    progress.percent &&
                                    !isNaN(progress.percent)
                                ) {
                                    percent =
                                        Math.min(
                                            100,
                                            Math.max(
                                                0,
                                                progress.percent
                                            )
                                        );
                                }
                                else if (
                                    duration > 0 &&
                                    progress.timemark
                                ) {

                                    const parts =
                                        progress.timemark.split(":");

                                    const seconds =
                                        (+parts[0] * 3600) +
                                        (+parts[1] * 60) +
                                        (+parts[2]);

                                    percent =
                                        Math.min(
                                            100,
                                            Math.max(
                                                0,
                                                (seconds / duration) * 100
                                            )
                                        );
                                }

                                console.log(
                                    `Processing: ${Math.round(percent)}%`
                                );
                            })

                            .on("end", () => {

                                console.log(
                                    "FFmpeg finished."
                                );

                                resolve();
                            })

                            .on("error", error => {

                                console.error(
                                    "FFmpeg error:",
                                    error.message
                                );

                                reject(error);
                            })

                            .run();
                    }
                );
            });

            if (!fs.existsSync(outputPath)) {
                throw new Error(
                    "FFmpeg completed but the output file was not created."
                );
            }

            const stats =
                fs.statSync(outputPath);

            if (stats.size < 10000) {
                throw new Error(
                    `Output video is invalid or too small (${stats.size} bytes).`
                );
            }

            console.log(
                "Output size:",
                (stats.size / 1024 / 1024).toFixed(2),
                "MB"
            );

            console.log(
                "Sending optimized video..."
            );

            res.download(
                outputPath,
                "optimized-video.mp4",
                downloadError => {

                    fs.unlink(
                        inputPath,
                        () => {}
                    );

                    fs.unlink(
                        outputPath,
                        () => {}
                    );

                    if (downloadError) {
                        console.error(
                            "Download error:",
                            downloadError
                        );
                    }
                }
            );

        }
        catch (error) {

            console.error(
                "Optimization failed:",
                error.message
            );

            fs.unlink(
                inputPath,
                () => {}
            );

            fs.unlink(
                outputPath,
                () => {}
            );

            if (!res.headersSent) {

                res.status(500).json({
                    error:
                        "Video processing failed.",
                    details:
                        error.message
                });
            }
        }
    }
);

app.use(
    (error, req, res, next) => {

        console.error(
            "Server error:",
            error.message
        );

        if (!res.headersSent) {

            res.status(400).json({
                error:
                    error.message ||
                    "Request failed."
            });
        }
    }
);

app.listen(
    PORT,
    () => {

        console.log(
            `Doniawik Video Optimizer running on port ${PORT}`
        );
    }
);
