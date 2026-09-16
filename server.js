// Probe duration and process video
ffmpeg.ffprobe(inputPath, (err, metadata) => {
    const totalDuration = metadata && metadata.format ? metadata.format.duration : 0;

    ffmpeg(inputPath)
        .outputOptions([
            "-c:v libx264",
            "-profile:v high",
            "-level:v 4.2",
            "-preset superfast",                              // Ultra-fast encoding without losing quality
            "-crf 18",                                        // Near-lossless visual quality
            "-maxrate 15M",                                   // Bypasses TikTok harsh bitrate squashing
            "-bufsize 30M",
            "-pix_fmt yuv420p",                               // Native TikTok color space
            "-vf scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,unsharp=3:3:0.4:3:3:0.0", // Auto 1080x1920 + subtle sharpening
            "-r 60",                                           // Force 60fps Constant Frame Rate
            "-c:a aac",
            "-b:a 192k",
            "-ar 48000",
            "-movflags +faststart"                            // Fast streaming web optimization
        ])
        .output(outputPath)
        .on("progress", (progress) => {
            const job = jobs.get(jobId);
            if (!job) return;

            let percent = 0;
            if (progress.percent && !isNaN(progress.percent)) {
                percent = Math.min(100, Math.max(0, progress.percent));
            } else if (totalDuration > 0 && progress.timemark) {
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
            fs.unlink(inputPath, () => {});
        })
        .on("error", (err) => {
            console.error(`FFmpeg processing error [${jobId}]:`, err.message);
            const job = jobs.get(jobId);
            if (job) {
                job.status = "error";
                job.error = "Failed to optimize video quality.";
            }
            fs.unlink(inputPath, () => {});
        })
        .run();
});
