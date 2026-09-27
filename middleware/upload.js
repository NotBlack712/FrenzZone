const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/jpg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' }
};

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB (covers video); images are typically far smaller

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const info = ALLOWED_TYPES[file.mimetype];
    const ext = info ? info.ext : path.extname(file.originalname).replace('.', '') || 'bin';
    const unique = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    cb(null, unique);
  }
});

function fileFilter(req, file, cb) {
  if (ALLOWED_TYPES[file.mimetype]) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Allowed: JPG, JPEG, PNG, GIF, MP4, WebM.'));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
});

function mediaKindFor(mimetype) {
  const info = ALLOWED_TYPES[mimetype];
  return info ? info.kind : null;
}

// ---------- Hardened image uploads (banner / group avatar) ----------
// Both are the same strict path, differing only in the filename prefix:
//   - images only (JPG / JPEG / PNG / WEBP), never video or anything else,
//   - 8MB maximum instead of 100MB,
//   - the extension is derived from the MIME type (never from the client's
//     filename), so a "payload.jpg.exe" can never land on disk as an exe,
//   - the first bytes of the saved file are re-checked against the expected
//     magic numbers, so MIME/extension claims are not trusted on their own.
const BANNER_TYPES = {
  'image/jpeg': { ext: 'jpg', magic: 'jpg' },
  'image/jpg': { ext: 'jpg', magic: 'jpg' },
  'image/png': { ext: 'png', magic: 'png' },
  'image/webp': { ext: 'webp', magic: 'webp' }
};
const BANNER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const BANNER_MAX_SIZE = 8 * 1024 * 1024; // 8MB (recommended range: 5-10MB)

function createImageUpload({ prefix, label }) {
  const imageStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = BANNER_TYPES[file.mimetype].ext;
      cb(null, `${prefix}${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
    }
  });

  function imageFileFilter(req, file, cb) {
    const info = BANNER_TYPES[file.mimetype];
    if (!info) {
      return cb(new Error(`${label} must be a JPG, JPEG, PNG or WEBP image.`));
    }
    // Extension check as well: the original filename must look like an image.
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext && !BANNER_EXTS.has(ext)) {
      return cb(new Error(`${label} file extension is not allowed. Use .jpg, .jpeg, .png or .webp.`));
    }
    cb(null, true);
  }

  return multer({
    storage: imageStorage,
    fileFilter: imageFileFilter,
    limits: { fileSize: BANNER_MAX_SIZE }
  });
}

const bannerUpload = createImageUpload({ prefix: 'banner-', label: 'Banner' });
const groupAvatarUpload = createImageUpload({ prefix: 'group-', label: 'Group image' });

// Verifies the saved file really is the image type it claims to be.
function verifyImageSignature(filePath, mimetype) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    if (read < 3) return false;

    const info = BANNER_TYPES[mimetype];
    if (!info) return false;

    if (info.magic === 'jpg') return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (info.magic === 'png') return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (info.magic === 'webp') {
      return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    }
    return false;
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

// Deletes an uploaded file ONLY when its name carries the expected prefix, so
// a crafted path can never make us remove someone else's avatar or a post.
function deleteUploadFile(filePath, prefix) {
  if (!filePath || typeof filePath !== 'string') return false;
  const base = path.basename(filePath);
  if (!base.startsWith(prefix)) return false;
  const full = path.join(UPLOAD_DIR, base);
  try {
    if (fs.existsSync(full)) { fs.unlinkSync(full); return true; }
  } catch (e) { /* ignore */ }
  return false;
}

module.exports = {
  upload,
  bannerUpload,
  groupAvatarUpload,
  verifyImageSignature,
  deleteUploadFile,
  mediaKindFor,
  UPLOAD_DIR
};
