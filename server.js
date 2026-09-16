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

/*
|--------------------------------------------------------------------------
| Upload configuration
|--------------------------------------------------------------------------
*/

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

/*
|--------------------------------------------------------------------------
| Job storage
|--------------------------------------------------------------------------
*/

const jobs = new Map();

/*
|--------------------------------------------------------------------------
| Basic routes
|--------------------------------------------------------------------------
*/

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


/*
|--------------------------------------------------------------------------
| Create optimization job
|--------------------------------------------------------------------------
*/

app.post(
    "/api/optimize",
    upload.single("video"),
    async (req, res) => {

        if (!req.file) {

            return res.status(400).json({
                error: "No video uploaded."
            });

        }

        const jobId = crypto.randomUUID();

        const inputFile = req.file.path;

        const outputFile = path.join(
            processedFolder,
            `${jobId}-optimized.mp4`
        );

        jobs.set(jobId, {

            id: jobId,

            status: "processing",

            progress: 0,

            originalName:
                req.file.originalname,

            originalSize:
                req.file.size,

            inputFile,

            outputFile,

            optimizedSize: null,

            error: null,

            startedAt: Date.now(),

            completedAt: null

        });


        console.log(
            `New optimization job: ${jobId}`
        );

        console.log(
            `File: ${req.file.originalname}`
        );

        console.log(
            `Size: ${(req.file.size / 1024 / 1024).toFixed(2)} MB`
        );


        /*
        |--------------------------------------------------------------------------
        | Start FFmpeg
        |--------------------------------------------------------------------------
        */

        ffmpeg(inputFile)

            .videoCodec("libx264")

            .outputOptions([

                // Good balance between speed and quality
                "-preset veryfast",

                // High quality while keeping file size reasonable
                "-crf 20",

                // TikTok/mobile friendly pixel format
                "-pix_fmt yuv420p",

                // AAC audio
                "-c:a aac",

                "-b:a 160k",

                // Fast MP4 startup
                "-movflags +faststart"

            ])

            .on("start", command => {

                console.log(
                    `FFmpeg started for ${jobId}`
                );

                console.log(command);

            })

            .on("progress", progress => {

                let percent =
                    Math.round(
                        progress.percent || 0
                    );

                percent =
                    Math.max(
                        0,
                        Math.min(
                            99,
                            percent
                        )
                    );

                const job =
                    jobs.get(jobId);

                if (job) {

                    job.progress =
                        percent;

                }

                console.log(
                    `${jobId}: ${percent}%`
                );

            })

            .on("end", () => {

                const job =
                    jobs.get(jobId);

                if (!job) {
                    return;
                }


                let optimizedSize = 0;

                try {

                    optimizedSize =
                        fs.statSync(
                            outputFile
                        ).size;

                } catch (error) {

                    console.error(
                        "Could not read output size:",
                        error
                    );

                }


                job.status =
                    "completed";

                job.progress =
                    100;

                job.optimizedSize =
                    optimizedSize;

                job.completedAt =
                    Date.now();


                console.log(
                    `Optimization complete: ${jobId}`
                );

                console.log(
                    `Output size: ${(optimizedSize / 1024 / 1024).toFixed(2)} MB`
                );

            })

            .on("error", error => {

                console.error(
                    `FFmpeg error for ${jobId}:`,
                    error.message
                );


                const job =
                    jobs.get(jobId);

                if (job) {

                    job.status =
                        "error";

                    job.error =
                        error.message;

                }


                fs.unlink(
                    inputFile,
                    () => {}
                );

                fs.unlink(
                    outputFile,
                    () => {}
                );

            })

            .save(outputFile);


        /*
        |--------------------------------------------------------------------------
        | Immediately tell frontend the job has started
        |--------------------------------------------------------------------------
        */

        res.json({

            success: true,

            jobId,

            originalName:
                req.file.originalname,

            originalSize:
                req.file.size

        });

    }
);


/*
|--------------------------------------------------------------------------
| Job status
|--------------------------------------------------------------------------
*/

app.get(
    "/api/status/:jobId",
    (req, res) => {

        const job =
            jobs.get(
                req.params.jobId
            );


        if (!job) {

            return res.status(404).json({

                error:
                    "Optimization job not found."

            });

        }


        res.json({

            success: true,

            jobId:
                job.id,

            status:
                job.status,

            progress:
                job.progress,

            originalName:
                job.originalName,

            originalSize:
                job.originalSize,

            optimizedSize:
                job.optimizedSize,

            error:
                job.error

        });

    }
);


/*
|--------------------------------------------------------------------------
| Download optimized video
|--------------------------------------------------------------------------
*/

app.get(
    "/api/download/:jobId",
    (req, res) => {

        const job =
            jobs.get(
                req.params.jobId
            );


        if (!job) {

            return res.status(404).json({

                error:
                    "Optimization job not found."

            });

        }


        if (
            job.status !==
            "completed"
        ) {

            return res.status(400).json({

                error:
                    "Video is not ready yet."

            });

        }


        if (
            !fs.existsSync(
                job.outputFile
            )
        ) {

            return res.status(404).json({

                error:
                    "Optimized video no longer exists."

            });

        }


        res.download(
            job.outputFile,
            "optimized-video.mp4",
            error => {

                /*
                |--------------------------------------------------------------------------
                | Clean files after download
                |--------------------------------------------------------------------------
                */

                fs.unlink(
                    job.inputFile,
                    () => {}
                );

                fs.unlink(
                    job.outputFile,
                    () => {}
                );

                jobs.delete(
                    job.id
                );


                if (error) {

                    console.error(
                        "Download error:",
                        error
                    );

                }

            }
        );

    }
);


/*
|--------------------------------------------------------------------------
| Cleanup abandoned jobs
|--------------------------------------------------------------------------
*/

setInterval(
    () => {

        const now =
            Date.now();

        for (
            const [
                jobId,
                job
            ] of jobs
        ) {

            /*
             * Delete jobs older than 30 minutes.
             */

            if (
                now -
                job.startedAt >
                30 * 60 * 1000
            ) {

                console.log(
                    `Cleaning old job: ${jobId}`
                );


                fs.unlink(
                    job.inputFile,
                    () => {}
                );

                fs.unlink(
                    job.outputFile,
                    () => {}
                );


                jobs.delete(
                    jobId
                );

            }

        }

    },
    5 * 60 * 1000
);


/*
|--------------------------------------------------------------------------
| Error handler
|--------------------------------------------------------------------------
*/

app.use(
    (error, req, res, next) => {

        console.error(
            error
        );


        if (
            !res.headersSent
        ) {

            res.status(400).json({

                error:
                    error.message ||
                    "Request failed."

            });

        }

    }
);


/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

app.listen(
    PORT,
    () => {

        console.log(
            `Doniawik Video Optimizer running on port ${PORT}`
        );

    }
);
