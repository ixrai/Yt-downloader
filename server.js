import express from "express";
import cors from "cors";
import { exec } from "child_process";
import fs from "fs";
import path from "path";

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
  console.log(`YT Downloader running on port ${PORT}`);
});

/* =========================
   ANALYZE YOUTUBE URL
   - VIDEO: 480p+
   - AUDIO: single best AAC (m4a)
========================= */
app.post("/analyze", (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: "No URL provided" });
  }

  const cmd = `python3 -m yt_dlp -J "${url}"`;

  exec(cmd, { maxBuffer: 1024 * 1024 * 30 }, (err, stdout, stderr) => {
    if (err) {
      console.error(stderr);
      return res.status(500).json({
        error: "yt-dlp failed",
        detail: err.message
      });
    }

    let data;
    try {
      data = JSON.parse(stdout);
    } catch {
      return res.status(500).json({ error: "Invalid yt-dlp response" });
    }

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
      // highest quality first
      .sort((a, b) => b.height - a.height);

    /* ---------- BEST AAC AUDIO (M4A ONLY) ---------- */
    const audioSource = data.formats
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
      audio: audioSource
        ? {
            id: audioSource.format_id,
            ext: "m4a",
            bitrate: audioSource.abr || null,
            sizeMB: audioSource.filesize
              ? (audioSource.filesize / 1024 / 1024).toFixed(2)
              : "unknown"
          }
        : null
    });
  });
});

/* =========================
   DOWNLOAD VIDEO / AUDIO
========================= */
app.get("/download", (req, res) => {
  const { url, format, type } = req.query;

  if (!url) {
    return res.status(400).send("Missing URL");
  }

  const downloadsDir = path.join(process.cwd(), "downloads");
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
  }

  let ytCmd;

  /* ---------- AUDIO ONLY (AAC) ---------- */
  if (type === "audio") {
    ytCmd = `
      python3 -m yt_dlp
      -f "bestaudio[ext=m4a]/bestaudio"
      -o "${downloadsDir}/%(title)s.%(ext)s"
      "${url}"
    `;
  }

  /* ---------- VIDEO (480p+, AUTO MERGE AAC) ---------- */
  else {
    if (!format) {
      return res.status(400).send("Missing format for video");
    }

    ytCmd = `
      python3 -m yt_dlp
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
