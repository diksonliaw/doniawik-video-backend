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
const processedFolder = path.join(__dirname, "processed");

fs.mkdirSync(uploadFolder, { recursive: true });
fs.mkdirSync(processedFolder, { recursive: true });

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

        const inputFile = req.file.path;

        const outputFile = path.join(
            processedFolder,
            `${path.parse(req.file.filename).name}-optimized.mp4`
        );

        console.log(
            `Received video: ${req.file.originalname}`
        );

        console.log(
            `File size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`
        );

        ffmpeg(inputFile)

            .videoCodec("libx264")

            .outputOptions([
                "-preset ultrafast",
                "-crf 23",
                "-pix_fmt yuv420p",
                "-c:a aac",
                "-b:a 128k",
                "-movflags +faststart"
            ])

            .on("start", command => {
                console.log("FFmpeg started:");
                console.log(command);
            })

            .on("progress", progress => {

                const percent =
                    Math.round(progress.percent || 0);

                console.log(
                    `Processing: ${percent}%`
                );
            })

            .on("end", () => {

                console.log(
                    "Optimization complete!"
                );

                res.download(
                    outputFile,
                    "optimized-video.mp4",
                    error => {

                        fs.unlink(
                            inputFile,
                            () => {}
                        );

                        fs.unlink(
                            outputFile,
                            () => {}
                        );

                        if (error) {
                            console.error(
                                "Download error:",
                                error
                            );
                        }
                    }
                );
            })

            .on("error", error => {

                console.error(
                    "FFmpeg error:",
                    error.message
                );

                fs.unlink(
                    inputFile,
                    () => {}
                );

                fs.unlink(
                    outputFile,
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
            })

            .save(outputFile);
    }
);

app.use(
    (error, req, res, next) => {

        console.error(error);

        if (!res.headersSent) {
            res.status(400).json({
                error: error.message
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
