import express from "express";
import cors from "cors";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   START SERVER
========================= */
app.listen(3000, () => {
  console.log("YT Downloader running on http://localhost:3000");
});

/* =========================
   ANALYZE YOUTUBE URL
   - VIDEO: 480p+
   - AUDIO: ONE BEST AAC (M4A)
========================= */
app.post("/analyze", (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  exec(
    `yt-dlp -J "${url}"`,
    { maxBuffer: 1024 * 1024 * 30 },
    (err, stdout) => {
      if (err) {
        return res.status(500).json({
          error: "yt-dlp failed",
          detail: err.message
        });
      }

      const data = JSON.parse(stdout);

      /* ---------- VIDEO FORMATS (>=480p) ---------- */
      const video = data.formats
        .filter(f =>
          f.vcodec !== "none" &&
          f.height &&
          f.height >= 480
        )
        .map(f => ({
          id: f.format_id,
          height: f.height,
          ext: f.ext,
          hasAudio: f.acodec !== "none",
          sizeMB: f.filesize
            ? (f.filesize / 1024 / 1024).toFixed(2)
            : "unknown"
        }))
        // remove duplicate resolutions
        .filter(
          (v, i, a) =>
            a.findIndex(x => x.height === v.height) === i
        )
        // highest first
        .sort((a, b) => b.height - a.height);

      /* ---------- SINGLE BEST AAC AUDIO ---------- */
      const audio = data.formats
        .filter(f =>
          f.vcodec === "none" &&
          f.acodec !== "none" &&
          f.ext === "m4a"
        )
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

      res.json({
        title: data.title,
        duration: data.duration,
        video,
        audio: audio
          ? {
              id: audio.format_id,
              ext: "m4a",
              bitrate: audio.abr || null,
              sizeMB: audio.filesize
                ? (audio.filesize / 1024 / 1024).toFixed(2)
                : "unknown"
            }
          : null
      });
    }
  );
});

/* =========================
   DOWNLOAD VIDEO OR AUDIO
========================= */
app.get("/download", (req, res) => {
  const { url, format, type } = req.query;

  if (!url || !format) {
    return res.status(400).send("Missing parameters");
  }

  const downloadsDir = path.join(process.cwd(), "downloads");

  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
  }

  let ytCmd;

  /* ---------- AUDIO ONLY (AAC) ---------- */
  if (type === "audio") {
    ytCmd = `
      yt-dlp
      -f "bestaudio[ext=m4a]/bestaudio"
      -o "${downloadsDir}/%(title)s.%(ext)s"
      "${url}"
    `;
  }
  /* ---------- VIDEO (AUTO MERGE AAC) ---------- */
  else {
    ytCmd = `
      yt-dlp
      -f ${format}
      --merge-output-format mp4
      -o "${downloadsDir}/%(title)s.%(ext)s"
      "${url}"
    `;
  }

  const cmd = ytCmd.replace(/\s+/g, " ");

  exec(cmd, { maxBuffer: 1024 * 1024 * 30 }, (err, stdout, stderr) => {
    if (err) {
      console.error(stderr);
      return res.status(500).send("Download failed");
    }

    const files = fs.readdirSync(downloadsDir)
      .map(name => ({
        name,
        time: fs.statSync(path.join(downloadsDir, name)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);

    if (!files.length) {
      return res.status(500).send("File not found");
    }

    const filePath = path.join(downloadsDir, files[0].name);

    res.download(filePath, () => {
      fs.unlink(filePath, () => {});
    });
  });
});
