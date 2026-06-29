import fs from "node:fs";
import path from "node:path";
import multer from "multer";

const uploadDir = process.env.LOCAL_UPLOAD_PATH || path.resolve("uploads");
fs.mkdirSync(uploadDir, { recursive: true });

export const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "-")}`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "video/mp4"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("Only JPG, PNG, and MP4 files are accepted"));
    cb(null, true);
  },
});

export function fileRecord(file: Express.Multer.File) {
  return { fileName: file.originalname, fileUrl: `/uploads/${file.filename}`, mimeType: file.mimetype, fileSize: file.size, type: file.mimetype.startsWith("video/") ? "VIDEO" : "IMAGE" };
}

export function deleteStoredFile(fileUrl: string) {
  if (!fileUrl.startsWith("/uploads/")) return;
  const target = path.join(uploadDir, path.basename(fileUrl));
  if (fs.existsSync(target)) fs.unlinkSync(target);
}
